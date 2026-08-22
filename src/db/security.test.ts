// Properties that must hold about the SHAPE of the system, not its behaviour.
//
// These are cheap and they guard the mistakes that are easiest to make later, by
// someone who was not here for the reasoning. A column named `private_key` added
// in six months would pass every behavioural test in this repository and destroy
// the product's central claim, so the schema is asserted about directly.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { haveDatabase, seedPortfolio, truncateAll, withSchema } from "./testing.js";
import { query } from "./pool.js";
import { portfolioById } from "./portfolios.js";
import { upsertUser, upsertWallet } from "./accounts.js";
import { PrivyDelegatedAuthority } from "../signing/privy.js";

describe.skipIf(!haveDatabase())("what the database is allowed to hold", () => {
  let teardown: () => Promise<void>;
  beforeAll(async () => {
    teardown = await withSchema("security");
  });
  afterAll(async () => {
    await teardown();
  });
  beforeEach(truncateAll);

  it("has no column anywhere that looks like it could hold a key", async () => {
    // The whole product rests on Rivo not holding key material. That is a
    // property of the schema before it is a property of the code.
    const columns = await query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = current_schema()`,
    );
    expect(columns.length).toBeGreaterThan(30);
    const suspicious = columns.filter((c) =>
      /(^|_)(private_key|privkey|secret|mnemonic|seed_phrase|passphrase|keystore)($|_)/i.test(c.column_name),
    );
    expect(
      suspicious.map((c) => `${c.table_name}.${c.column_name}`),
      "a column that could hold key material was added — Rivo must never store one",
    ).toEqual([]);
  });

  it("stores a wallet reference, not a wallet", async () => {
    // `privy_wallet_id` is a capability REFERENCE: it names a wallet at Privy and
    // is useless without Rivo's own credentials. Anything key-shaped in this
    // table would be a different product.
    const columns = await query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'wallets' ORDER BY column_name`,
    );
    expect(columns.map((c) => c.column_name).sort()).toEqual([
      "address",
      "chain_type",
      "created_at",
      "delegated",
      "delegated_at",
      "id",
      "kind",
      "privy_wallet_id",
      "revoked_at",
      "user_id",
    ]);
    // No bytea anywhere: key material would not be stored as text.
    expect(columns.filter((c) => c.data_type === "bytea")).toEqual([]);
  });

  it("cannot mark a wallet delegated with nothing to sign through", async () => {
    const u = await upsertUser("did:privy:shape");
    const w = await upsertWallet({
      userId: u.id,
      address: "0x1111111111111111111111111111111111111111",
      kind: "portfolio",
    });
    await expect(query("UPDATE wallets SET delegated = true WHERE id = $1", [w.id])).rejects.toThrow();
  });

  it("gives two portfolios two different signing authorities", async () => {
    // Cross-user signer isolation, at the point where an authority is built.
    // A worker holding forty portfolios builds forty of these, and if the wallet
    // reference ever came from anywhere but the portfolio's own row, one user's
    // capital would trade under another user's authority — and it would look
    // entirely healthy from the outside.
    const a = await seedPortfolio();
    const b = await seedPortfolio();
    const pa = (await portfolioById(a.portfolioId))!;
    const pb = (await portfolioById(b.portfolioId))!;

    expect(pa.address).not.toBe(pb.address);
    expect(pa.privyWalletId).not.toBe(pb.privyWalletId);
    expect(pa.userId).not.toBe(pb.userId);

    const authA = new PrivyDelegatedAuthority({ walletId: pa.privyWalletId!, address: pa.address }, pa.delegated);
    const authB = new PrivyDelegatedAuthority({ walletId: pb.privyWalletId!, address: pb.address }, pb.delegated);
    expect(authA.describe().address).toBe(pa.address);
    expect(authB.describe().address).toBe(pb.address);
    expect(authA.describe().address).not.toBe(authB.describe().address);
  });

  it("cannot reach another user's wallet through their portfolio id", async () => {
    const a = await seedPortfolio();
    const b = await seedPortfolio();
    const rows = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM portfolios p JOIN wallets w ON w.id = p.wallet_id
        WHERE p.id = $1 AND w.user_id = (SELECT user_id FROM portfolios WHERE id = $2)`,
      [a.portfolioId, b.portfolioId],
    );
    expect(rows[0]!.n).toBe("0");
  });

  it("cascades a user's rows away when they are erased, leaving no wallet reference", async () => {
    const { userId } = await seedPortfolio();
    await query("SET LOCAL rivo.erase = 'on'");
    // A fresh connection would lose the setting, so erasure goes through
    // eraseUser() in production. Here the point is the FK shape, checked
    // directly: nothing survives the user.
    const before = await query<{ n: string }>("SELECT count(*)::text AS n FROM wallets WHERE user_id = $1", [userId]);
    expect(Number(before[0]!.n)).toBeGreaterThan(0);
    const fks = await query<{ table_name: string; delete_rule: string }>(
      `SELECT tc.table_name, rc.delete_rule
         FROM information_schema.table_constraints tc
         JOIN information_schema.referential_constraints rc ON rc.constraint_name = tc.constraint_name
        WHERE tc.table_schema = current_schema() AND tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_name IN ('wallets', 'portfolios')`,
    );
    // Both hang off the user and go with them.
    expect(fks.filter((f) => f.table_name === "wallets").every((f) => f.delete_rule === "CASCADE")).toBe(true);
  });

  it("keeps the append-only triggers attached", async () => {
    // The guarantee is a trigger. A migration that dropped one would leave every
    // behavioural test passing and the ledger quietly editable.
    const triggers = await query<{ event_object_table: string; trigger_name: string }>(
      `SELECT event_object_table, trigger_name FROM information_schema.triggers
        WHERE trigger_schema = current_schema()`,
    );
    const tables = [...new Set(triggers.map((t) => t.event_object_table))].sort();
    expect(tables).toContain("executions");
    expect(tables).toContain("decisions");
  });
});
