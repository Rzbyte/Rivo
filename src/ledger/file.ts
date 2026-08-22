// The execution ledger on a filesystem.
//
// Event-sourced rather than mutated: every transition appends a line, and the
// current state of a row is the fold of its lines. That is what makes "append
// only" a property of the file rather than a promise about the code — nothing
// here ever opens the file for anything but `a`.
//
// It exists so that the whole product works with no database: the CLI, a local
// single-portfolio run, the backtester and the test suite all get real execution
// provenance without provisioning anything. Production uses the Postgres ledger,
// which enforces the same rules with a trigger instead of a convention.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import {
  isTerminal,
  type ExecutionIntent,
  type ExecutionLedger,
  type ExecutionRecord,
  type ExecutionStatus,
  type Fill,
} from "./types.js";

/** One appended line. `t` is the transition; everything else is its payload. */
type Entry =
  | ({ t: "intend" } & ExecutionRecord)
  | { t: "submitted"; id: string; txHash: string; at: number }
  | ({ t: "confirmed"; id: string; at: number } & Fill)
  | { t: "failed"; id: string; at: number; error: string; meta?: Record<string, unknown> }
  | { t: "orphaned"; id: string; at: number; reason: string };

export const executionLogPath = (dataDir: string): string => join(dataDir, "executions.jsonl");

const now = (): number => Math.floor(Date.now() / 1000);

export class FileExecutionLedger implements ExecutionLedger {
  constructor(readonly path: string) {}

  private append(e: Entry): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.path, JSON.stringify(e) + "\n", { flag: "a" });
  }

  /**
   * Fold the log into the current state of every row.
   *
   * Reads the whole file. That is acceptable here and not in the decision log:
   * an execution is an action that cost gas, and a portfolio produces tens of
   * them a day where it produces thousands of decisions. If that ever stops
   * being true, the answer is the Postgres ledger, not a tail heuristic that
   * would silently drop the oldest transactions from the record.
   */
  private fold(): Map<string, ExecutionRecord> {
    const rows = new Map<string, ExecutionRecord>();
    if (!existsSync(this.path)) return rows;
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (line.trim().length === 0) continue;
      let e: Entry;
      try {
        e = JSON.parse(line) as Entry;
      } catch {
        continue; // a torn last line after a hard kill
      }
      if (e.t === "intend") {
        const { t: _t, ...rec } = e;
        rows.set(rec.id, rec as ExecutionRecord);
        continue;
      }
      const row = rows.get(e.id);
      if (!row) continue; // a transition whose intent is not in this file
      if (e.t === "submitted") {
        row.status = "submitted";
        row.txHash = e.txHash;
        row.submittedAt = e.at;
      } else if (e.t === "confirmed") {
        row.status = "confirmed";
        row.filledQty = e.filledQty;
        row.filledPrice = e.filledPrice;
        row.cost = e.cost;
        if (e.txHash) row.txHash = e.txHash;
        if (e.blockNumber !== undefined) row.blockNumber = e.blockNumber;
        if (e.meta) row.meta = { ...row.meta, ...e.meta };
        row.confirmedAt = e.at;
      } else if (e.t === "failed") {
        row.status = "failed";
        row.error = e.error;
        if (e.meta) row.meta = { ...row.meta, ...e.meta };
        row.confirmedAt = e.at;
      } else if (e.t === "orphaned") {
        row.status = "orphaned";
        row.error = e.reason;
        row.confirmedAt = e.at;
      }
    }
    return rows;
  }

  async intend(intent: ExecutionIntent): Promise<ExecutionRecord> {
    const existing = await this.find(intent.portfolioId, intent.idempotencyKey);
    if (existing) return existing;
    const rec: ExecutionRecord = { ...intent, id: randomUUID(), status: "intended", createdAt: now() };
    this.append({ t: "intend", ...rec });
    return rec;
  }

  async find(portfolioId: string, idempotencyKey: string): Promise<ExecutionRecord | null> {
    for (const r of this.fold().values()) {
      if (r.portfolioId === portfolioId && r.idempotencyKey === idempotencyKey) return r;
    }
    return null;
  }

  async submitted(id: string, txHash: string): Promise<void> {
    this.append({ t: "submitted", id, txHash, at: now() });
  }

  async confirmed(id: string, fill: Fill): Promise<void> {
    this.append({ t: "confirmed", id, at: now(), ...fill });
  }

  async failed(id: string, error: string, meta?: Record<string, unknown>): Promise<void> {
    this.append({ t: "failed", id, at: now(), error, ...(meta ? { meta } : {}) });
  }

  async orphaned(id: string, reason: string): Promise<void> {
    this.append({ t: "orphaned", id, at: now(), reason });
  }

  async unresolved(portfolioId: string): Promise<ExecutionRecord[]> {
    return [...this.fold().values()]
      .filter((r) => r.portfolioId === portfolioId && !isTerminal(r.status as ExecutionStatus))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async list(portfolioId: string, limit = 200): Promise<ExecutionRecord[]> {
    return [...this.fold().values()]
      .filter((r) => r.portfolioId === portfolioId)
      .sort((a, b) => b.createdAt - a.createdAt || (b.id < a.id ? -1 : 1))
      .slice(0, limit);
  }

  async count(portfolioId: string): Promise<number> {
    let n = 0;
    for (const r of this.fold().values()) if (r.portfolioId === portfolioId) n++;
    return n;
  }
}
