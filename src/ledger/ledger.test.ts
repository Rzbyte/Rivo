// The execution ledger, both implementations, against the same contract.
//
// These exist because of a specific defect: provenance used to live on the
// position object, so closing a position deleted the record of the transaction
// that opened it. A finished portfolio could show 208 positions and ten hashes.
// Every test below is about the record OUTLIVING the thing it describes.
//
// The Postgres cases run only when DATABASE_URL is set, and they are the ones
// that matter for the append-only claim: a file is append-only because this code
// only opens it with `a`, while a table is append-only because the server
// refuses anything else — including a hand-written UPDATE from a console.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileExecutionLedger, executionLogPath } from "./file.js";
import { PostgresExecutionLedger } from "./postgres.js";
import { idempotencyKey, isTerminal, type ExecutionLedger } from "./types.js";
import { recover, ORPHAN_AFTER_SEC } from "./recording.js";
import type { ReceiptReader } from "../runtime/receipt.js";
import { haveDatabase, seedPortfolio, truncateAll, withSchema } from "../db/testing.js";
import { query } from "../db/pool.js";
import { eraseUser } from "../db/accounts.js";

const PORTFOLIO = "11111111-1111-1111-1111-111111111111";

const intent = (over: Partial<Parameters<ExecutionLedger["intend"]>[0]> = {}) => ({
  portfolioId: PORTFOLIO,
  idempotencyKey: idempotencyKey({ cycle: 1, action: "BUY", marketId: "0xMARKET", leg: "UP" as const }),
  cycle: 1,
  marketId: "0xmarket",
  action: "BUY" as const,
  leg: "UP" as const,
  requestedQty: 10,
  requestedPrice: 0.42,
  mode: "live" as const,
  ...over,
});

/** The contract both stores must satisfy, run twice. */
function contract(name: string, make: () => ExecutionLedger, portfolio: () => string) {
  describe(name, () => {
    it("records an intent before anything is signed", async () => {
      const led = make();
      const row = await led.intend(intent({ portfolioId: portfolio() }));
      expect(row.status).toBe("intended");
      expect(row.txHash).toBeUndefined();
      expect(row.requestedQty).toBe(10);
      expect(row.requestedPrice).toBeCloseTo(0.42, 10);
    });

    it("returns the SAME row for a repeated key instead of a second one", async () => {
      const led = make();
      const a = await led.intend(intent({ portfolioId: portfolio() }));
      const b = await led.intend(intent({ portfolioId: portfolio() }));
      expect(b.id).toBe(a.id);
      expect(await led.count(portfolio())).toBe(1);
    });

    it("walks intended -> submitted -> confirmed, keeping the hash", async () => {
      const led = make();
      const row = await led.intend(intent({ portfolioId: portfolio() }));
      await led.submitted(row.id, "0xdeadbeef");
      await led.confirmed(row.id, { filledQty: 9.5, filledPrice: 0.41, cost: 3.895, blockNumber: 1234 });
      const after = await led.find(portfolio(), row.idempotencyKey);
      expect(after?.status).toBe("confirmed");
      expect(after?.txHash).toBe("0xdeadbeef");
      expect(after?.filledQty).toBeCloseTo(9.5, 10);
      expect(after?.blockNumber).toBe(1234);
      expect(after?.submittedAt).toBeGreaterThan(0);
    });

    it("keeps the transaction after the position it opened is gone", async () => {
      // The whole point. Nothing here has a position at all — the record stands
      // on its own, which is precisely what the old design could not do.
      const led = make();
      const row = await led.intend(intent({ portfolioId: portfolio() }));
      await led.submitted(row.id, "0xabc123");
      await led.confirmed(row.id, { filledQty: 10, filledPrice: 0.42, cost: 4.2 });
      const history = await led.list(portfolio());
      expect(history).toHaveLength(1);
      expect(history[0]!.txHash).toBe("0xabc123");
    });

    it("records a failure with its reason rather than dropping it", async () => {
      const led = make();
      const row = await led.intend(intent({ portfolioId: portfolio() }));
      await led.failed(row.id, "placeBinaryOrder reverted: lot size");
      const after = await led.find(portfolio(), row.idempotencyKey);
      expect(after?.status).toBe("failed");
      expect(after?.error).toContain("lot size");
    });

    it("distinguishes orphaned from failed", async () => {
      const led = make();
      const row = await led.intend(intent({ portfolioId: portfolio() }));
      await led.submitted(row.id, "0xmaybe");
      await led.orphaned(row.id, "no receipt");
      const after = await led.find(portfolio(), row.idempotencyKey);
      expect(after?.status).toBe("orphaned");
      expect(isTerminal("orphaned")).toBe(true);
      // Still carries the hash, so a human can go and look.
      expect(after?.txHash).toBe("0xmaybe");
    });

    it("lists only what is unresolved", async () => {
      const led = make();
      const a = await led.intend(intent({ portfolioId: portfolio() }));
      const b = await led.intend(
        intent({ portfolioId: portfolio(), idempotencyKey: "2:BUY:0xother:DOWN", marketId: "0xother", leg: "DOWN" }),
      );
      await led.confirmed(a.id, { filledQty: 1, filledPrice: 0.5, cost: 0.5 });
      const open = await led.unresolved(portfolio());
      expect(open.map((r) => r.id)).toEqual([b.id]);
    });

    it("keeps portfolios apart", async () => {
      const led = make();
      await led.intend(intent({ portfolioId: portfolio() }));
      const other = "22222222-2222-2222-2222-222222222222";
      expect(await led.find(other, intent().idempotencyKey)).toBeNull();
      expect(await led.count(other)).toBe(0);
    });
  });
}

describe("the file execution ledger", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rivo-exec-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  contract(
    "contract",
    () => new FileExecutionLedger(executionLogPath(dir)),
    () => PORTFOLIO,
  );

  it("only ever appends — a transition adds a line, it does not rewrite one", async () => {
    const led = new FileExecutionLedger(executionLogPath(dir));
    const row = await led.intend(intent());
    await led.submitted(row.id, "0xfeed");
    await led.confirmed(row.id, { filledQty: 1, filledPrice: 0.5, cost: 0.5 });
    const lines = readFileSync(executionLogPath(dir), "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!).t).toBe("intend");
    // The original intent is still on disk, unmodified, after two transitions.
    expect(JSON.parse(lines[0]!).status).toBe("intended");
  });

  it("survives a torn final line", async () => {
    const led = new FileExecutionLedger(executionLogPath(dir));
    const row = await led.intend(intent());
    const path = executionLogPath(dir);
    const text = readFileSync(path, "utf8");
    rmSync(path);
    // A hard kill mid-write leaves half a record. It must cost that record and
    // nothing else.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, text + '{"t":"submitted","id":"' + row.id.slice(0, 8));
    const again = new FileExecutionLedger(path);
    expect(await again.count(PORTFOLIO)).toBe(1);
    expect((await again.find(PORTFOLIO, row.idempotencyKey))?.status).toBe("intended");
  });
});

describe.skipIf(!haveDatabase())("the postgres execution ledger", () => {
  let teardown: () => Promise<void>;
  let portfolioId: string;

  beforeAll(async () => {
    teardown = await withSchema("ledger");
  });
  afterAll(async () => {
    await teardown();
  });
  beforeEach(async () => {
    await truncateAll();
    portfolioId = (await seedPortfolio()).portfolioId;
  });

  contract(
    "contract",
    () => new PostgresExecutionLedger(),
    () => portfolioId,
  );

  it("REFUSES a delete, at the database", async () => {
    const led = new PostgresExecutionLedger();
    const row = await led.intend(intent({ portfolioId }));
    await expect(query("DELETE FROM executions WHERE id = $1", [row.id])).rejects.toThrow(/append-only/);
  });

  it("REFUSES to rewrite what was intended", async () => {
    const led = new PostgresExecutionLedger();
    const row = await led.intend(intent({ portfolioId }));
    await expect(query("UPDATE executions SET requested_qty = 999 WHERE id = $1", [row.id])).rejects.toThrow(
      /append-only/,
    );
    await expect(query("UPDATE executions SET action = 'SELL' WHERE id = $1", [row.id])).rejects.toThrow(
      /append-only/,
    );
  });

  it("REFUSES to replace a recorded transaction hash", async () => {
    const led = new PostgresExecutionLedger();
    const row = await led.intend(intent({ portfolioId }));
    await led.submitted(row.id, "0xreal");
    await expect(query("UPDATE executions SET tx_hash = '0xfake' WHERE id = $1", [row.id])).rejects.toThrow(
      /already recorded/,
    );
  });

  it("REFUSES to move a row backwards", async () => {
    const led = new PostgresExecutionLedger();
    const row = await led.intend(intent({ portfolioId }));
    await led.confirmed(row.id, { filledQty: 1, filledPrice: 0.5, cost: 0.5 });
    await expect(query("UPDATE executions SET status = 'intended' WHERE id = $1", [row.id])).rejects.toThrow(
      /cannot go from/,
    );
  });

  it("REFUSES to change a terminal row, except to resolve an orphan", async () => {
    const led = new PostgresExecutionLedger();
    const a = await led.intend(intent({ portfolioId }));
    await led.confirmed(a.id, { filledQty: 1, filledPrice: 0.5, cost: 0.5 });
    await expect(query("UPDATE executions SET status = 'failed' WHERE id = $1", [a.id])).rejects.toThrow(
      /already confirmed/,
    );

    const b = await led.intend(intent({ portfolioId, idempotencyKey: "9:BUY:0xz:UP", marketId: "0xz" }));
    await led.submitted(b.id, "0xlate");
    await led.orphaned(b.id, "no receipt in time");
    // Finding the receipt later is allowed to settle the question.
    await led.confirmed(b.id, { filledQty: 3, filledPrice: 0.5, cost: 1.5, blockNumber: 7 });
    expect((await led.find(portfolioId, "9:BUY:0xz:UP"))?.status).toBe("confirmed");
  });

  it("holds decisions immutable too", async () => {
    await query(
      `INSERT INTO decisions (portfolio_id, cycle, market_id, asset, interval_sec, leg, action, binding)
       VALUES ($1, 1, '0xm', 'BTC', 900, 'UP', 'SKIP', 'BTC delta budget')`,
      [portfolioId],
    );
    await expect(query("UPDATE decisions SET binding = 'nothing' WHERE portfolio_id = $1", [portfolioId])).rejects.toThrow(
      /append-only/,
    );
    await expect(query("DELETE FROM decisions WHERE portfolio_id = $1", [portfolioId])).rejects.toThrow(/append-only/);
  });

  it("cascades from the user, so deleting an account leaves nothing behind", async () => {
    const led = new PostgresExecutionLedger();
    await led.intend(intent({ portfolioId }));
    const owner = await query<{ user_id: string }>("SELECT user_id FROM portfolios WHERE id = $1", [portfolioId]);
    const user_id = owner[0]!.user_id;
    // The append-only trigger protects the ledger from being edited, not from
    // the user exercising their right to be forgotten. Those are different
    // things and the schema treats them differently on purpose — but the
    // difference has to be DECLARED, which is what eraseUser does.
    await expect(query("DELETE FROM users WHERE id = $1", [user_id])).rejects.toThrow(/append-only/);
    await eraseUser(user_id);
    const left = await query<{ n: string }>("SELECT count(*)::text AS n FROM executions");
    expect(left[0]!.n).toBe("0");
  });
});

describe("recovery after a crash", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rivo-rec-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const reader = (map: Record<string, { ok: boolean; blockNumber: number } | null>): ReceiptReader => ({
    receipt: async (h) => map[h] ?? null,
  });

  it("confirms a submitted row the chain says succeeded", async () => {
    const led = new FileExecutionLedger(executionLogPath(dir));
    const row = await led.intend(intent());
    await led.submitted(row.id, "0xok");
    const out = await recover(led, PORTFOLIO, reader({ "0xok": { ok: true, blockNumber: 42 } }));
    expect(out.resolved).toBe(1);
    const after = await led.find(PORTFOLIO, row.idempotencyKey);
    expect(after?.status).toBe("confirmed");
    expect(after?.blockNumber).toBe(42);
  });

  it("fails a submitted row the chain says reverted", async () => {
    const led = new FileExecutionLedger(executionLogPath(dir));
    const row = await led.intend(intent());
    await led.submitted(row.id, "0xbad");
    await recover(led, PORTFOLIO, reader({ "0xbad": { ok: false, blockNumber: 43 } }));
    expect((await led.find(PORTFOLIO, row.idempotencyKey))?.status).toBe("failed");
  });

  it("does NOT conclude anything from an RPC that will not answer", async () => {
    // The distinction the whole design rests on: no receipt is not "not mined".
    const led = new FileExecutionLedger(executionLogPath(dir));
    const row = await led.intend(intent());
    await led.submitted(row.id, "0xunknown");
    const out = await recover(led, PORTFOLIO, reader({}));
    expect(out.stillPending).toBe(1);
    expect(out.orphaned).toBe(0);
    expect((await led.find(PORTFOLIO, row.idempotencyKey))?.status).toBe("submitted");
  });

  it("orphans an unanswerable row once it is old enough, and says why", async () => {
    const led = new FileExecutionLedger(executionLogPath(dir));
    const row = await led.intend(intent());
    await led.submitted(row.id, "0xunknown");
    const later = Math.floor(Date.now() / 1000) + ORPHAN_AFTER_SEC + 1;
    const out = await recover(led, PORTFOLIO, reader({}), later);
    expect(out.orphaned).toBe(1);
    const after = await led.find(PORTFOLIO, row.idempotencyKey);
    expect(after?.status).toBe("orphaned");
    expect(after?.error).toContain("no receipt");
  });

  it("orphans an intent that never got a hash, naming reconciliation as the authority", async () => {
    const led = new FileExecutionLedger(executionLogPath(dir));
    const row = await led.intend(intent());
    const later = Math.floor(Date.now() / 1000) + ORPHAN_AFTER_SEC + 1;
    await recover(led, PORTFOLIO, reader({}), later);
    const after = await led.find(PORTFOLIO, row.idempotencyKey);
    expect(after?.status).toBe("orphaned");
    expect(after?.error).toMatch(/reconciliation/i);
  });
});
