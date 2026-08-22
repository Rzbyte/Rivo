// Portfolios: the unit of capital, risk, isolation and scheduling.
//
// The row is deliberately the same shape the engine already reasons about.
// `PortfolioPolicy` in src/portfolio/policy.ts predates the database by weeks
// and is what `resolvePolicy` turns into risk limits, so storing anything else
// would mean a translation layer whose only job is to be subtly wrong once.
//
// EVERY function here takes the owner as well as the id. A route that forgets to
// check ownership then finds nothing rather than succeeding against somebody
// else's portfolio — the failure mode is a 404, not a breach. The two functions
// that legitimately have no user in hand are the scheduler's, and they are named
// so that using one by accident in a request handler reads wrong.

import { maybe, one, query, secs, tx } from "./pool.js";
import { parsePolicy, type PortfolioPolicy, type RunMode, type RunState } from "../portfolio/policy.js";
import type { ProfileName } from "../portfolio/profiles.js";
import type { Network } from "../core/config.js";

export interface Portfolio {
  id: string;
  userId: string;
  walletId: string;
  /** The address Rivo trades from. Denormalised on read because everything needs it. */
  address: `0x${string}`;
  /** Whether the user has granted Rivo authority to sign for that address. */
  delegated: boolean;
  privyWalletId: string | null;
  network: Network;
  policy: PortfolioPolicy;
  createdAt: number;
  updatedAt: number;
  nextRunAt: number;
}

interface Row {
  id: string;
  user_id: string;
  wallet_id: string;
  address: string;
  delegated: boolean;
  privy_wallet_id: string | null;
  network: string;
  capital: string;
  profile: string;
  mode: string;
  state: string;
  overrides: Record<string, unknown>;
  stopped_reason: string | null;
  created_at: Date;
  updated_at: Date;
  next_run_at: Date;
}

const SELECT = `
  SELECT p.id, p.user_id, p.wallet_id, w.address, w.delegated, w.privy_wallet_id,
         p.network, p.capital, p.profile, p.mode, p.state, p.overrides, p.stopped_reason,
         p.created_at, p.updated_at, p.next_run_at
    FROM portfolios p
    JOIN wallets w ON w.id = p.wallet_id`;

export function toPortfolio(r: Row): Portfolio {
  // Through parsePolicy rather than assembled by hand: it is the one function
  // that knows which overrides are legal, and a policy that skipped it could
  // carry a limit the UI can never have set.
  const policy = parsePolicy({
    owner: r.address,
    capital: Number(r.capital),
    profile: r.profile as ProfileName,
    mode: r.mode as RunMode,
    state: r.state as RunState,
    overrides: r.overrides ?? {},
    createdAt: secs(r.created_at),
    updatedAt: secs(r.updated_at),
    ...(r.stopped_reason ? { stoppedReason: r.stopped_reason } : {}),
  });
  return {
    id: r.id,
    userId: r.user_id,
    walletId: r.wallet_id,
    address: r.address as `0x${string}`,
    delegated: r.delegated,
    privyWalletId: r.privy_wallet_id,
    network: r.network as Network,
    policy,
    createdAt: secs(r.created_at),
    updatedAt: secs(r.updated_at),
    nextRunAt: secs(r.next_run_at),
  };
}

export async function createPortfolio(input: {
  userId: string;
  walletId: string;
  network: Network;
  capital: number;
  profile: ProfileName;
  mode?: RunMode;
}): Promise<Portfolio> {
  // All three rows, or none.
  //
  // The runtime row and the lease row are created WITH the portfolio rather than
  // lazily: a worker that has to create its own lock row races every other
  // worker doing the same thing, and the one place that cannot happen is here.
  // Wrapping them together also means a failure partway through cannot leave a
  // portfolio that exists and cannot be read — which is exactly what happened
  // when a malformed wallet address made the read-back throw after the insert
  // had already committed.
  const id = await tx(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO portfolios (user_id, wallet_id, network, capital, profile, mode, state)
       VALUES ($1, $2, $3, $4, $5, $6, 'idle') RETURNING id`,
      [input.userId, input.walletId, input.network, input.capital, input.profile, input.mode ?? "shadow"],
    );
    const created = rows[0]!.id;
    await c.query("INSERT INTO portfolio_runtime (portfolio_id, cash, peak_equity) VALUES ($1, $2, $2)", [
      created,
      input.capital,
    ]);
    await c.query("INSERT INTO portfolio_leases (portfolio_id) VALUES ($1) ON CONFLICT DO NOTHING", [created]);
    return created;
  });
  const created = await portfolioOf(input.userId, id);
  if (!created) throw new Error("portfolio vanished immediately after being created");
  return created;
}

/** One portfolio, only if this user owns it. */
export async function portfolioOf(userId: string, id: string): Promise<Portfolio | null> {
  const r = await maybe<Row>(`${SELECT} WHERE p.id = $1 AND p.user_id = $2`, [id, userId]);
  return r ? toPortfolio(r) : null;
}

export async function portfoliosOf(userId: string): Promise<Portfolio[]> {
  const rows = await query<Row>(`${SELECT} WHERE p.user_id = $1 ORDER BY p.created_at`, [userId]);
  return rows.map(toPortfolio);
}

/** For the worker, which holds a lease rather than a session. Never call this from a request. */
export async function portfolioById(id: string): Promise<Portfolio | null> {
  const r = await maybe<Row>(`${SELECT} WHERE p.id = $1`, [id]);
  return r ? toPortfolio(r) : null;
}

export interface PolicyUpdate {
  capital?: number;
  profile?: ProfileName;
  mode?: RunMode;
  overrides?: PortfolioPolicy["overrides"];
}

/**
 * Change what the user configured.
 *
 * `state` is deliberately not settable here. Running, paused and halted are
 * lifecycle transitions with their own rules — a halted portfolio must not
 * become running because someone saved the settings form — so they go through
 * `setState` and are visible as such in the code that calls them.
 */
export async function updatePolicy(userId: string, id: string, patch: PolicyUpdate): Promise<Portfolio | null> {
  const r = await maybe<Row>(
    `WITH updated AS (
       UPDATE portfolios
          SET capital   = COALESCE($3, capital),
              profile   = COALESCE($4, profile),
              mode      = COALESCE($5, mode),
              overrides = COALESCE($6::jsonb, overrides),
              updated_at = now()
        WHERE id = $1 AND user_id = $2
        RETURNING *
     )
     SELECT u.id, u.user_id, u.wallet_id, w.address, w.delegated, w.privy_wallet_id,
            u.network, u.capital, u.profile, u.mode, u.state, u.overrides, u.stopped_reason,
            u.created_at, u.updated_at, u.next_run_at
       FROM updated u JOIN wallets w ON w.id = u.wallet_id`,
    [
      id,
      userId,
      patch.capital ?? null,
      patch.profile ?? null,
      patch.mode ?? null,
      patch.overrides ? JSON.stringify(patch.overrides) : null,
    ],
  );
  return r ? toPortfolio(r) : null;
}

/**
 * Move a portfolio through its lifecycle.
 *
 * `due` decides whether the scheduler should look at it immediately. Starting
 * sets it to now, so enabling Autopilot produces a cycle within seconds rather
 * than at the next tick — which is the difference between a product that feels
 * alive and one the user refreshes at.
 */
export async function setState(
  userId: string | null,
  id: string,
  state: RunState,
  reason?: string | null,
): Promise<Portfolio | null> {
  const r = await maybe<Row>(
    `WITH updated AS (
       UPDATE portfolios
          SET state = $3,
              stopped_reason = $4,
              updated_at = now(),
              next_run_at = CASE WHEN $3 = 'running' THEN now() ELSE next_run_at END
        WHERE id = $1 AND ($2::uuid IS NULL OR user_id = $2)
        RETURNING *
     )
     SELECT u.id, u.user_id, u.wallet_id, w.address, w.delegated, w.privy_wallet_id,
            u.network, u.capital, u.profile, u.mode, u.state, u.overrides, u.stopped_reason,
            u.created_at, u.updated_at, u.next_run_at
       FROM updated u JOIN wallets w ON w.id = u.wallet_id`,
    [id, userId, state, reason ?? null],
  );
  return r ? toPortfolio(r) : null;
}

/** Tell the scheduler when to look at this portfolio again. Worker-side. */
export async function scheduleNext(id: string, seconds: number): Promise<void> {
  await query(`UPDATE portfolios SET next_run_at = now() + make_interval(secs => $2) WHERE id = $1`, [
    id,
    Math.max(1, Math.round(seconds)),
  ]);
}

/**
 * Autopilot's precondition, in one place.
 *
 * A portfolio may trade for real only when the user asked for it AND the wallet
 * is still delegated. The second half is the one that matters: revoking
 * delegation in Privy has to stop trading even if nothing told Rivo, so the
 * check is a read of current state rather than a flag Rivo set once.
 */
export const mayTradeLive = (p: Portfolio): boolean =>
  p.policy.mode === "autopilot" && p.delegated && Boolean(p.privyWalletId);
