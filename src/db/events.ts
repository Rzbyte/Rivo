// What an operator, or a user, needs to be told.
//
// The distinction this table draws is the one that decides whether alerting is
// useful or ignored: a SKIP is a decision, not an event. Rivo refuses most of
// the opportunities it sees — that is the product working — and a system that
// alerts on it teaches everyone to mute it, so the one alert that mattered
// arrives into a muted channel.
//
// What lands here instead: a breaker firing, a portfolio halting, a
// reconciliation mismatch, a claim that will not settle, a run of RPC failures,
// an execution left orphaned. Things that are either actionable or genuinely
// surprising.

import { query, secs } from "./pool.js";

export type Severity = "info" | "warn" | "error";

export interface RivoEvent {
  id: number;
  portfolioId: string | null;
  at: number;
  kind: string;
  severity: Severity;
  message: string;
  data: Record<string, unknown>;
  notifiedAt: number | null;
}

interface Row {
  id: string;
  portfolio_id: string | null;
  at: Date;
  kind: string;
  severity: string;
  message: string;
  data: Record<string, unknown>;
  notified_at: Date | null;
}

const toEvent = (r: Row): RivoEvent => ({
  id: Number(r.id),
  portfolioId: r.portfolio_id,
  at: secs(r.at),
  kind: r.kind,
  severity: r.severity as Severity,
  message: r.message,
  data: r.data ?? {},
  notifiedAt: r.notified_at ? secs(r.notified_at) : null,
});

const COLUMNS = "id, portfolio_id, at, kind, severity, message, data, notified_at";

export async function record(
  portfolioId: string | null,
  kind: string,
  severity: Severity,
  message: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  await query(
    `INSERT INTO events (portfolio_id, kind, severity, message, data) VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [portfolioId, kind, severity, message.slice(0, 2000), JSON.stringify(data)],
  );
}

/**
 * Record something, but at most once per window.
 *
 * The reconciliation finding that repeats every cycle is the motivating case:
 * one unclaimable holding produced the identical warning on every pass, and the
 * decision log became something people scrolled past rather than read. Suppress
 * the restatement, keep the first, and let it re-fire once the window lapses so
 * a condition that is STILL true after an hour says so again.
 */
export async function recordOnce(
  portfolioId: string | null,
  kind: string,
  severity: Severity,
  message: string,
  data: Record<string, unknown> = {},
  withinSec = 3600,
): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `INSERT INTO events (portfolio_id, kind, severity, message, data)
     SELECT $1, $2, $3, $4, $5::jsonb
      WHERE NOT EXISTS (
        SELECT 1 FROM events
         WHERE kind = $2
           AND portfolio_id IS NOT DISTINCT FROM $1
           AND message = $4
           AND at > now() - make_interval(secs => $6)
      )
     RETURNING id`,
    [portfolioId, kind, severity, message.slice(0, 2000), JSON.stringify(data), withinSec],
  );
  return rows.length > 0;
}

export async function recent(portfolioId: string, limit = 50): Promise<RivoEvent[]> {
  const rows = await query<Row>(
    `SELECT ${COLUMNS} FROM events WHERE portfolio_id = $1 ORDER BY at DESC, id DESC LIMIT $2`,
    [portfolioId, Math.min(500, Math.max(1, limit))],
  );
  return rows.map(toEvent);
}

/** Everything that deserves an alert and has not had one. Fleet-wide. */
export async function undelivered(limit = 20): Promise<RivoEvent[]> {
  const rows = await query<Row>(
    `SELECT ${COLUMNS} FROM events WHERE notified_at IS NULL AND severity <> 'info'
      ORDER BY at ASC LIMIT $1`,
    [Math.min(200, Math.max(1, limit))],
  );
  return rows.map(toEvent);
}

export async function markNotified(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await query("UPDATE events SET notified_at = now() WHERE id = ANY($1::bigint[])", [ids]);
}
