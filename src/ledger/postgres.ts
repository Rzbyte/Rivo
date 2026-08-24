// The execution ledger in PostgreSQL.
//
// Same contract as the file ledger, with the append-only rule enforced by the
// database instead of by the shape of the writes: `executions` carries a trigger
// that refuses every DELETE, refuses to rewrite what was intended, refuses to
// replace a recorded transaction hash with a different one, and refuses to move
// a row backwards through its state machine. See migrations/001_init.sql.
//
// That distinction is the reason to prefer this in production. A file ledger is
// append-only because this code only ever opens it with `a`; a Postgres ledger
// is append-only because the server will raise an exception at anything else,
// including a hand-written UPDATE from a console at 3am.

import { maybe, num, numOrNull, one, query, secs, secsOrNull } from "../db/pool.js";
import type { Leg } from "../engine/book.js";
import {
  type ExecutionAction,
  type ExecutionIntent,
  type ExecutionLedger,
  type ExecutionRecord,
  type ExecutionStatus,
  type Fill,
} from "./types.js";

interface Row {
  id: string;
  portfolio_id: string;
  idempotency_key: string;
  cycle: string | number;
  market_id: string;
  action: string;
  leg: string | null;
  requested_qty: string | null;
  requested_price: string | null;
  filled_qty: string | null;
  filled_price: string | null;
  cost: string | null;
  tx_hash: string | null;
  block_number: string | null;
  status: string;
  error: string | null;
  meta: Record<string, unknown>;
  created_at: Date;
  submitted_at: Date | null;
  confirmed_at: Date | null;
}

export function toRecord(r: Row): ExecutionRecord {
  const meta = r.meta ?? {};
  const rec: ExecutionRecord = {
    id: r.id,
    portfolioId: r.portfolio_id,
    idempotencyKey: r.idempotency_key,
    cycle: Number(r.cycle),
    marketId: r.market_id,
    action: r.action as ExecutionAction,
    status: r.status as ExecutionStatus,
    // `mode` is provenance rather than a column: it never appears in a WHERE
    // clause, and a boolean column that only the UI reads is a column that will
    // be wrong for six months before anyone notices.
    mode: meta.mode === "live" ? "live" : "dry",
    createdAt: secs(r.created_at),
    meta,
  };
  if (r.leg) rec.leg = r.leg as Leg;
  const q = numOrNull(r.requested_qty);
  if (q !== null) rec.requestedQty = q;
  const p = numOrNull(r.requested_price);
  if (p !== null) rec.requestedPrice = p;
  const fq = numOrNull(r.filled_qty);
  if (fq !== null) rec.filledQty = fq;
  const fp = numOrNull(r.filled_price);
  if (fp !== null) rec.filledPrice = fp;
  const c = numOrNull(r.cost);
  if (c !== null) rec.cost = c;
  if (r.tx_hash) rec.txHash = r.tx_hash;
  if (r.block_number !== null) rec.blockNumber = Number(r.block_number);
  if (r.error) rec.error = r.error;
  const sub = secsOrNull(r.submitted_at);
  if (sub !== null) rec.submittedAt = sub;
  const con = secsOrNull(r.confirmed_at);
  if (con !== null) rec.confirmedAt = con;
  return rec;
}

const COLUMNS = `id, portfolio_id, idempotency_key, cycle, market_id, action, leg,
  requested_qty, requested_price, filled_qty, filled_price, cost, tx_hash, block_number,
  status, error, meta, created_at, submitted_at, confirmed_at`;

export class PostgresExecutionLedger implements ExecutionLedger {
  async intend(intent: ExecutionIntent): Promise<ExecutionRecord> {
    // ON CONFLICT DO NOTHING plus a read, rather than DO UPDATE: a colliding key
    // means this intent already exists, and the existing row is the answer. An
    // upsert would rewrite the intent, which the trigger would refuse anyway —
    // correctly, because the first record of what was meant is the one worth
    // keeping.
    const meta = { ...(intent.meta ?? {}), mode: intent.mode };
    const inserted = await maybe<Row>(
      `INSERT INTO executions (portfolio_id, idempotency_key, cycle, market_id, action, leg,
                               requested_qty, requested_price, status, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'intended', $9)
       ON CONFLICT (portfolio_id, idempotency_key) DO NOTHING
       RETURNING ${COLUMNS}`,
      [
        intent.portfolioId,
        intent.idempotencyKey,
        intent.cycle,
        intent.marketId,
        intent.action,
        intent.leg ?? null,
        intent.requestedQty ?? null,
        intent.requestedPrice ?? null,
        JSON.stringify(meta),
      ],
    );
    if (inserted) return toRecord(inserted);
    const existing = await this.find(intent.portfolioId, intent.idempotencyKey);
    if (!existing) throw new Error(`execution ${intent.idempotencyKey} collided but could not be read back`);
    return existing;
  }

  async find(portfolioId: string, idempotencyKey: string): Promise<ExecutionRecord | null> {
    const r = await maybe<Row>(
      `SELECT ${COLUMNS} FROM executions WHERE portfolio_id = $1 AND idempotency_key = $2`,
      [portfolioId, idempotencyKey],
    );
    return r ? toRecord(r) : null;
  }

  async submitted(id: string, txHash: string): Promise<void> {
    await query(
      `UPDATE executions SET status = 'submitted', tx_hash = $2, submitted_at = now()
       WHERE id = $1 AND status = 'intended'`,
      [id, txHash],
    );
  }

  async confirmed(id: string, fill: Fill): Promise<void> {
    await query(
      `UPDATE executions
          SET status = 'confirmed',
              filled_qty = $2, filled_price = $3, cost = $4,
              tx_hash = COALESCE(tx_hash, $5), block_number = COALESCE($6, block_number),
              submitted_at = COALESCE(submitted_at, now()),
              confirmed_at = now(),
              meta = meta || $7::jsonb
        WHERE id = $1 AND status IN ('intended', 'submitted', 'orphaned')`,
      [
        id,
        fill.filledQty,
        fill.filledPrice,
        fill.cost,
        fill.txHash ?? null,
        fill.blockNumber ?? null,
        JSON.stringify(fill.meta ?? {}),
      ],
    );
  }

  async failed(id: string, error: string, meta?: Record<string, unknown>): Promise<void> {
    await query(
      `UPDATE executions SET status = 'failed', error = $2, confirmed_at = now(), meta = meta || $3::jsonb
        WHERE id = $1 AND status IN ('intended', 'submitted', 'orphaned')`,
      [id, error.slice(0, 2000), JSON.stringify(meta ?? {})],
    );
  }

  async orphaned(id: string, reason: string): Promise<void> {
    await query(
      `UPDATE executions SET status = 'orphaned', error = $2, confirmed_at = now()
        WHERE id = $1 AND status IN ('intended', 'submitted')`,
      [id, reason.slice(0, 2000)],
    );
  }

  async unresolved(portfolioId: string): Promise<ExecutionRecord[]> {
    const rows = await query<Row>(
      `SELECT ${COLUMNS} FROM executions
        WHERE portfolio_id = $1 AND status IN ('intended', 'submitted')
        ORDER BY created_at ASC`,
      [portfolioId],
    );
    return rows.map(toRecord);
  }

  async list(portfolioId: string, limit = 200): Promise<ExecutionRecord[]> {
    const rows = await query<Row>(
      `SELECT ${COLUMNS} FROM executions WHERE portfolio_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
      [portfolioId, Math.min(1000, Math.max(1, limit))],
    );
    return rows.map(toRecord);
  }

  async count(portfolioId: string): Promise<number> {
    const r = await one<{ n: string }>(`SELECT count(*)::text AS n FROM executions WHERE portfolio_id = $1`, [
      portfolioId,
    ]);
    return num(r.n);
  }

  /** Link an execution to the position it acted on, for the audit trail. */
  async link(positionId: string, executionId: string, role: "open" | "increase" | "reduce" | "close" | "claim"): Promise<void> {
    await query(
      `INSERT INTO position_executions (position_id, execution_id, role) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [positionId, executionId, role],
    );
  }
}
