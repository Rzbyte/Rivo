// What an agent WOULD have done, and what then happened.
//
// Shadow is not a debug mode. It is the step between "this model looked good on
// history" and "this model may spend money", and the only honest way to run it
// is against live markets in real time — replaying history proves a model can
// fit the past, and nothing about whether it can decide in the present.
//
// Every row here is hypothetical, permanently. The column names say so
// (`hypothetical_size`, `hypothetical_entry`, `hypothetical_pnl`) because the
// failure mode is not a bug, it is a sentence: somebody quotes shadow P&L as a
// result. Keeping the word in the schema means a query has to opt into the lie.
//
// When the contract settles, the same truth that closes a real position resolves
// the shadow row. That is the loop the product is about:
//
//     MARKET → PREDICTION → DECISION → OUTCOME → EVIDENCE

import { query } from "../db/pool.js";
import type { Asset } from "../core/config.js";
import type { Leg } from "../engine/book.js";

export interface ShadowDecision {
  agentId: string;
  /**
   * The deployment this decision belongs to, when there is one.
   *
   * An agent can run in more than one place at once — a shadow deployment and an
   * experimental testnet deployment — and the Proof surface has to be able to
   * say which run produced which evidence. Null means the agent was asked
   * outside any deployment, which is a real case and not a missing value.
   */
  portfolioId?: string | null;
  marketId: string;
  asset: Asset;
  leg: Leg;
  intervalSec: number;
  /** Unix seconds at settlement. */
  expiry: number;
  /** What the venue asked at the moment of the decision. */
  marketPrice: number;
  /** What the agent thought it was worth. Null when it declined to say. */
  agentPrice: number | null;
  confidence: number | null;
  action: string;
  reason: string | null;
  /** The trade that was NOT placed. */
  hypotheticalSize: number | null;
  hypotheticalEntry: number | null;
}

/** Record a decision that moved nothing. */
export async function recordShadow(d: ShadowDecision): Promise<void> {
  await query(
    `INSERT INTO shadow_decisions
       (agent_id, portfolio_id, market_id, asset, leg, interval_sec, expiry,
        market_price, agent_price, confidence, action, reason,
        hypothetical_size, hypothetical_entry)
     VALUES ($1,$2,$3,$4,$5,$6, to_timestamp($7), $8,$9,$10,$11,$12,$13,$14)`,
    [
      d.agentId, d.portfolioId ?? null, d.marketId, d.asset, d.leg, d.intervalSec, d.expiry,
      d.marketPrice, d.agentPrice, d.confidence, d.action, d.reason,
      d.hypotheticalSize, d.hypotheticalEntry,
    ],
  );
}

/** A shadow row waiting on its contract. */
export interface Pending {
  id: string;
  marketId: string;
  leg: Leg;
  hypotheticalSize: number | null;
  hypotheticalEntry: number | null;
}

/**
 * Rows whose contract has expired and which have not been resolved.
 *
 * `graceSec` exists because expiry is when trading stops, not when the venue has
 * finalised an outcome. Asking too early gets `finalized: false` and burns a
 * round trip per row per pass.
 */
export async function pendingShadow(now: number, graceSec = 120, limit = 500): Promise<Pending[]> {
  const rows = await query<{ id: string; market_id: string; leg: string; hypothetical_size: string | null; hypothetical_entry: string | null }>(
    `SELECT id::text, market_id, leg, hypothetical_size::text, hypothetical_entry::text
       FROM shadow_decisions
      WHERE settled_at IS NULL AND expiry < to_timestamp($1)
      ORDER BY expiry
      LIMIT $2`,
    [now - graceSec, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    marketId: r.market_id,
    leg: r.leg as Leg,
    hypotheticalSize: r.hypothetical_size === null ? null : Number(r.hypothetical_size),
    hypotheticalEntry: r.hypothetical_entry === null ? null : Number(r.hypothetical_entry),
  }));
}

/**
 * What one share of `leg` was worth once the market resolved.
 *
 * The venue reports `winningOutcome` as 0 for UP. Voided markets return null:
 * there is no outcome to record, and writing 0 would say the leg lost.
 */
export function payout(leg: Leg, winningOutcome: number | null, voided: boolean): 0 | 1 | null {
  if (voided || winningOutcome === null) return null;
  const upWon = winningOutcome === 0;
  return leg === "UP" ? (upWon ? 1 : 0) : upWon ? 0 : 1;
}

/**
 * Per-share profit on a hypothetical entry.
 *
 * `settlement − entry`, which for a binary contract is the whole arithmetic.
 * Null entry means the agent declined to size the trade, so there is nothing to
 * price and the row records an outcome without a P&L rather than a zero.
 */
export function hypotheticalPnl(outcome: 0 | 1, entry: number | null, size: number | null): number | null {
  if (entry === null || size === null) return null;
  return (outcome - entry) * size;
}

/** Write the outcome back. Idempotent: a row already settled is left alone. */
export async function resolveShadow(id: string, outcome: 0 | 1, pnl: number | null): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE shadow_decisions
        SET settled_at = now(), outcome = $2, hypothetical_pnl = $3
      WHERE id = $1::bigint AND settled_at IS NULL
      RETURNING id::text`,
    [id, outcome, pnl],
  );
  return rows.length > 0;
}

export interface ShadowSummary {
  decisions: number;
  settled: number;
  /** Decisions that would have entered, among those settled. */
  entered: number;
  /** Sum of hypothetical P&L over settled entries. Null when none priced. */
  hypotheticalPnl: number | null;
  /** Fraction of settled entries that paid out. */
  hitRate: number | null;
}

/**
 * What an agent's shadow record adds up to. Every number is hypothetical.
 *
 * `portfolioId` narrows it to one deployment. Without that narrowing an agent
 * running in two places reports both under either, which is the shape of the
 * bug this parameter exists to prevent.
 */
export async function shadowSummary(agentId: string, portfolioId?: string | null): Promise<ShadowSummary> {
  const [r] = await query<{
    decisions: string; settled: string; entered: string; pnl: string | null; hits: string | null;
  }>(
    `SELECT count(*)::text                                                            AS decisions,
            count(*) FILTER (WHERE settled_at IS NOT NULL)::text                      AS settled,
            count(*) FILTER (WHERE settled_at IS NOT NULL
                              AND hypothetical_entry IS NOT NULL)::text               AS entered,
            sum(hypothetical_pnl) FILTER (WHERE settled_at IS NOT NULL)::text         AS pnl,
            avg(outcome::numeric) FILTER (WHERE settled_at IS NOT NULL
                              AND hypothetical_entry IS NOT NULL)::text               AS hits
       FROM shadow_decisions
      WHERE agent_id = $1
        AND ($2::uuid IS NULL OR portfolio_id = $2::uuid)`,
    [agentId, portfolioId ?? null],
  );
  return {
    decisions: Number(r?.decisions ?? 0),
    settled: Number(r?.settled ?? 0),
    entered: Number(r?.entered ?? 0),
    hypotheticalPnl: r?.pnl == null ? null : Number(r.pnl),
    hitRate: r?.hits == null ? null : Number(r.hits),
  };
}
