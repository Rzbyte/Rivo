// Users, and the wallets they own.
//
// Rivo stores an identity and an address. It does not store a password, a
// session secret, an API key or anything that could be used to move money — the
// only credential in the system belongs to Privy, and Privy keeps it. That is
// what makes this table boring, and boring is the correct thing for it to be.
//
// The two wallet kinds are a product distinction, not a technical one:
//
//   portfolio  the wallet Rivo trades. It has a Privy wallet id, so Rivo can ask
//              for a signature — but only while `delegated` is true, which the
//              user grants once and can revoke at any time.
//   external   a wallet the user connected to sign in or to fund from. No Privy
//              wallet id, and therefore nothing Rivo could ask it to do even if
//              it wanted to. The absence is the guarantee.

import { maybe, one, query, secs, tx } from "./pool.js";

export interface User {
  id: string;
  privyDid: string;
  email: string | null;
  createdAt: number;
  lastSeenAt: number;
}

export interface Wallet {
  id: string;
  userId: string;
  address: `0x${string}`;
  privyWalletId: string | null;
  kind: "portfolio" | "external";
  chainType: string;
  delegated: boolean;
  delegatedAt: number | null;
  revokedAt: number | null;
  createdAt: number;
}

interface UserRow {
  id: string;
  privy_did: string;
  email: string | null;
  created_at: Date;
  last_seen_at: Date;
}

interface WalletRow {
  id: string;
  user_id: string;
  address: string;
  privy_wallet_id: string | null;
  kind: string;
  chain_type: string;
  delegated: boolean;
  delegated_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
}

const toUser = (r: UserRow): User => ({
  id: r.id,
  privyDid: r.privy_did,
  email: r.email,
  createdAt: secs(r.created_at),
  lastSeenAt: secs(r.last_seen_at),
});

const toWallet = (r: WalletRow): Wallet => ({
  id: r.id,
  userId: r.user_id,
  address: r.address as `0x${string}`,
  privyWalletId: r.privy_wallet_id,
  kind: r.kind as Wallet["kind"],
  chainType: r.chain_type,
  delegated: r.delegated,
  delegatedAt: r.delegated_at ? secs(r.delegated_at) : null,
  revokedAt: r.revoked_at ? secs(r.revoked_at) : null,
  createdAt: secs(r.created_at),
});

/**
 * Find or create the user behind a verified Privy identity.
 *
 * The caller must have VERIFIED the token first — this function trusts the DID
 * it is handed completely, because there is no way for it to check. Every route
 * that reaches it goes through `requireUser` in the web layer, and that is the
 * only place a token is ever accepted.
 */
export async function upsertUser(privyDid: string, email?: string | null): Promise<User> {
  const r = await one<UserRow>(
    `INSERT INTO users (privy_did, email) VALUES ($1, $2)
     ON CONFLICT (privy_did) DO UPDATE
        SET last_seen_at = now(),
            -- Never overwrite a known email with a null: a login method that
            -- carries no email must not erase one an earlier login established.
            email = COALESCE(EXCLUDED.email, users.email)
     RETURNING id, privy_did, email, created_at, last_seen_at`,
    [privyDid, email ?? null],
  );
  return toUser(r);
}

const WALLET_COLUMNS = `id, user_id, address, privy_wallet_id, kind, chain_type, delegated, delegated_at, revoked_at, created_at`;

export async function upsertWallet(input: {
  userId: string;
  address: string;
  kind: "portfolio" | "external";
  privyWalletId?: string | null;
  chainType?: string;
}): Promise<Wallet> {
  const r = await one<WalletRow>(
    `INSERT INTO wallets (user_id, address, privy_wallet_id, kind, chain_type)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, address) DO UPDATE
        SET privy_wallet_id = COALESCE(EXCLUDED.privy_wallet_id, wallets.privy_wallet_id),
            kind = wallets.kind
     RETURNING ${WALLET_COLUMNS}`,
    [input.userId, input.address.toLowerCase(), input.privyWalletId ?? null, input.kind, input.chainType ?? "ethereum"],
  );
  return toWallet(r);
}

export async function walletsOf(userId: string): Promise<Wallet[]> {
  const rows = await query<WalletRow>(`SELECT ${WALLET_COLUMNS} FROM wallets WHERE user_id = $1 ORDER BY created_at`, [
    userId,
  ]);
  return rows.map(toWallet);
}

// There was a `walletById(id)` here, unused, and the only read in this file that
// did not name the owner. The rule the comment below states is the whole reason
// a route that forgets its ownership check fails safe; an accessor sitting here
// ready to break it, tested by nothing, is a footgun rather than an API. Add it
// back scoped by user id if something ever needs it.

/**
 * Record that the user granted — or withdrew — Rivo's authority to sign.
 *
 * Scoped by user id as well as wallet id, deliberately. Every mutating query in
 * this codebase names the owner even when the primary key alone would find the
 * row, so that a route which forgot to check ownership fails to find anything
 * rather than succeeding against somebody else's wallet.
 */
export async function setDelegated(userId: string, walletId: string, delegated: boolean): Promise<Wallet | null> {
  const r = await maybe<WalletRow>(
    `UPDATE wallets
        SET delegated = $3,
            delegated_at = CASE WHEN $3 THEN now() ELSE delegated_at END,
            revoked_at   = CASE WHEN $3 THEN NULL  ELSE now()         END
      WHERE id = $2 AND user_id = $1 AND kind = 'portfolio'
      RETURNING ${WALLET_COLUMNS}`,
    [userId, walletId, delegated],
  );
  return r ? toWallet(r) : null;
}

/**
 * Delete a user and everything that belongs to them.
 *
 * The execution ledger and the decision log are append-only and the database
 * enforces it, so this is the one path allowed to remove those rows — declared
 * explicitly with a transaction-local setting so the exception cannot leak into
 * the next statement. See the trigger in migrations/001_init.sql.
 *
 * Portfolios are stopped first rather than deleted out from under a running
 * worker: a lease-holding cycle that finds its portfolio gone mid-pass would
 * fail in a way nobody wants to debug at 3am.
 */
export async function eraseUser(userId: string): Promise<void> {
  await tx(async (c) => {
    await c.query("SET LOCAL rivo.erase = 'on'");
    await c.query(
      `UPDATE portfolios SET state = 'stopped', stopped_reason = 'account erased', updated_at = now()
        WHERE user_id = $1`,
      [userId],
    );
    await c.query("DELETE FROM users WHERE id = $1", [userId]);
  });
}
