// RivoState, in PostgreSQL.
//
// The engine has one in-memory shape and it does not change. This maps that
// shape onto four tables and back, and nothing above it knows the difference —
// `cycle()` receives something it can `save()` into, exactly as it did when that
// was a JSON file.
//
// THREE DECISIONS WORTH THE READING TIME:
//
// 1. POSITIONS ARE ROWS, NOT A BLOB. A JSON column would have been a day's less
//    work and would have made "which positions are open across the fleet",
//    "what expires in the next ten minutes" and "one open position per leg"
//    into application code. The last one is a UNIQUE index here, so the engine's
//    long-standing assumption is now enforced rather than maintained.
//
// 2. CLOSED HISTORY IS BOUNDED ON READ, NEVER ON WRITE. A portfolio that has
//    been running for a month has thousands of closed positions and the cycle
//    needs none of them. `load` takes a recent window; `save` only ever appends
//    to what is beyond it. Nothing is lost — the rows are all still there, and
//    the reports read them directly.
//
// 3. SAVES ARE VERSION-CHECKED. The lease is what stops two workers touching one
//    portfolio, and this is the assertion behind it: a save that finds the
//    version moved throws instead of overwriting. A lock nobody checks is a
//    lock you are hoping about.

import { at, num, one, query, secs, tx } from "../db/pool.js";
import type { PoolClient } from "pg";
import type { Asset } from "../core/config.js";
import type { Leg } from "../engine/book.js";
import type { ClosedPosition, DecisionRecord, HeldPosition, RivoState } from "../runtime/state.js";
import { STATE_VERSION, repairLedger } from "../runtime/state.js";
import { StaleStateError, type DecisionSink, type StateSink } from "./types.js";

/** How much settled history a cycle is handed. Reports read the table instead. */
export const CLOSED_WINDOW = 500;

interface RuntimeRow {
  cash: string;
  realized_pnl: string;
  contributed: string;
  cycles: string;
  peak_equity: string;
  halted: string | null;
  dry_run: boolean;
  traded_by: string | null;
  started_at: Date;
  last_cycle_at: Date | null;
  last_claim_sweep_at: Date | null;
  leg_state: { lastTradedAt?: Record<string, number>; failures?: Record<string, { count: number; lastAt: number }> };
  version: string;
  capital: string;
  profile: string;
}

interface PositionRow {
  id: string;
  market_id: string;
  asset: string;
  interval_sec: number;
  leg: string;
  shares: string;
  entry_price: string;
  cost: string;
  fair_at_entry: string;
  delta_per_share: string;
  expiry: Date;
  opened_at: Date;
  adopted: boolean;
  closed_at: Date | null;
  won: boolean | null;
  proceeds: string | null;
  exit: string | null;
}

const toHeld = (r: PositionRow): HeldPosition => ({
  id: r.id,
  marketId: r.market_id,
  asset: r.asset as Asset,
  intervalSec: r.interval_sec,
  leg: r.leg as Leg,
  shares: num(r.shares),
  entryPrice: num(r.entry_price),
  cost: num(r.cost),
  expiry: secs(r.expiry),
  deltaPer1PctPerShare: num(r.delta_per_share),
  openedAt: secs(r.opened_at),
  fairAtEntry: num(r.fair_at_entry),
  ...(r.adopted ? { adopted: true } : {}),
});

const toClosed = (r: PositionRow): ClosedPosition => ({
  id: r.id,
  marketId: r.market_id,
  asset: r.asset as Asset,
  intervalSec: r.interval_sec,
  leg: r.leg as Leg,
  shares: num(r.shares),
  entryPrice: num(r.entry_price),
  cost: num(r.cost),
  fairAtEntry: num(r.fair_at_entry),
  openedAt: secs(r.opened_at),
  closedAt: r.closed_at ? secs(r.closed_at) : 0,
  won: r.won ? 1 : 0,
  proceeds: num(r.proceeds),
  exit: (r.exit ?? "settled") as ClosedPosition["exit"],
});

const POSITION_COLUMNS = `id, market_id, asset, interval_sec, leg, shares, entry_price, cost,
  fair_at_entry, delta_per_share, expiry, opened_at, adopted, closed_at, won, proceeds, exit`;

/**
 * The state store for one portfolio.
 *
 * Instance per portfolio per cycle, deliberately. It carries the version it read
 * and the watermark into `state.closed` it has already persisted, and neither of
 * those means anything across portfolios or across a reload.
 */
export class PostgresStateStore implements StateSink {
  private version = 0;
  /** How many entries of `state.closed` are already rows. */
  private closedWatermark = 0;

  constructor(readonly portfolioId: string) {}

  async load(): Promise<RivoState> {
    const r = await one<RuntimeRow>(
      `SELECT rt.cash, rt.realized_pnl, rt.contributed, rt.cycles, rt.peak_equity, rt.halted,
              rt.dry_run, rt.traded_by, rt.started_at, rt.last_cycle_at, rt.last_claim_sweep_at,
              rt.leg_state, rt.version, p.capital, p.profile
         FROM portfolio_runtime rt JOIN portfolios p ON p.id = rt.portfolio_id
        WHERE rt.portfolio_id = $1`,
      [this.portfolioId],
    );
    this.version = Number(r.version);

    const open = await query<PositionRow>(
      `SELECT ${POSITION_COLUMNS} FROM positions WHERE portfolio_id = $1 AND status = 'open' ORDER BY opened_at`,
      [this.portfolioId],
    );
    const closed = await query<PositionRow>(
      `SELECT ${POSITION_COLUMNS} FROM positions WHERE portfolio_id = $1 AND status = 'closed'
        ORDER BY closed_at DESC LIMIT $2`,
      [this.portfolioId, CLOSED_WINDOW],
    );

    const state: RivoState = {
      version: STATE_VERSION,
      capital: num(r.capital),
      contributed: num(r.contributed),
      cash: num(r.cash),
      realizedPnl: num(r.realized_pnl),
      open: open.map(toHeld),
      // Oldest first, so `state.closed` reads the way it always has and anything
      // appending to it appends at the end.
      closed: closed.map(toClosed).reverse(),
      cycles: Number(r.cycles),
      startedAt: secs(r.started_at),
      lastCycleAt: r.last_cycle_at ? secs(r.last_cycle_at) : 0,
      lastClaimSweepAt: r.last_claim_sweep_at ? secs(r.last_claim_sweep_at) : 0,
      halted: r.halted,
      peakEquity: num(r.peak_equity),
      profile: r.profile,
      dryRun: r.dry_run,
      ...(r.traded_by ? { tradedBy: r.traded_by } : {}),
      lastTradedAt: r.leg_state?.lastTradedAt ?? {},
      ...(r.leg_state?.failures ? { failures: r.leg_state.failures } : {}),
    };
    this.closedWatermark = state.closed.length;
    // The same repair the file store performs, for the same reason: a state that
    // does not balance is one whose P&L is already wrong, and absorbing the
    // difference somewhere visible beats leaving it hidden inside cash.
    return repairLedger(state, (m) => console.warn(`[${this.portfolioId}] ${m}`));
  }

  async save(state: RivoState): Promise<void> {
    await tx(async (c) => {
      const bumped = await c.query(
        `UPDATE portfolio_runtime
            SET cash = $2, realized_pnl = $3, contributed = $4, cycles = $5, peak_equity = $6,
                halted = $7, dry_run = $8, traded_by = COALESCE(traded_by, $9),
                last_cycle_at = $10, last_claim_sweep_at = $11, leg_state = $12::jsonb,
                version = version + 1
          WHERE portfolio_id = $1 AND version = $13`,
        [
          this.portfolioId,
          state.cash,
          state.realizedPnl,
          state.contributed ?? 0,
          state.cycles,
          state.peakEquity,
          state.halted,
          state.dryRun,
          state.tradedBy ?? null,
          at(state.lastCycleAt),
          at(state.lastClaimSweepAt),
          JSON.stringify({
            lastTradedAt: state.lastTradedAt ?? {},
            ...(state.failures ? { failures: state.failures } : {}),
          }),
          this.version,
        ],
      );
      if (bumped.rowCount === 0) throw new StaleStateError(this.portfolioId, this.version);
      this.version++;

      await this.persistOpen(c, state);
      await this.persistClosed(c, state);
    });
    this.closedWatermark = state.closed.length;
  }

  /**
   * Write every open position, assigning ids to the ones that do not have one.
   *
   * LOTS ARE ROWS. The engine holds several lots of one leg on purpose — the
   * allocator tops a leg up by adding a lot rather than resizing the existing
   * one, so each keeps the price it was actually filled at, and `reconcile`
   * corrects them proportionally.
   *
   * This used to upsert against a unique index on (portfolio, market, leg),
   * which meant a second lot silently overwrote the first. The portfolio lost a
   * position's cost on every reload; the ledger identity was repaired three
   * times in forty cycles, drifting negative; and because each cycle reloads
   * from the database, the allocator saw less exposure than it held and kept
   * buying — measured at 200% of the BTC delta budget on a live run.
   *
   * So: a lot with an id is an UPDATE, a lot without one is an INSERT, and
   * nothing here collapses two lots into one row. A failed update falls through
   * to an insert rather than dropping the position, which also covers the case
   * where a rolled-back transaction left an id pointing at a row that never
   * committed.
   */
  private async persistOpen(c: PoolClient, state: RivoState): Promise<void> {
    for (const p of state.open) {
      if (p.id) {
        const updated = await c.query(
          `UPDATE positions
              SET shares = $3, cost = $4, entry_price = $5, fair_at_entry = $6,
                  delta_per_share = $7, expiry = $8, adopted = $9
            WHERE id = $2 AND portfolio_id = $1 AND status = 'open'`,
          [
            this.portfolioId,
            p.id,
            p.shares,
            p.cost,
            p.entryPrice,
            p.fairAtEntry,
            p.deltaPer1PctPerShare,
            at(p.expiry),
            p.adopted ?? false,
          ],
        );
        // A position whose row is no longer open — reconciliation closed it in
        // another pass, say — is re-inserted rather than lost. Falling through
        // is deliberate: silently dropping it would take a live position out of
        // the portfolio's own view of itself.
        if (updated.rowCount !== 0) continue;
      }
      const inserted = await c.query<{ id: string }>(
        `INSERT INTO positions (portfolio_id, market_id, asset, interval_sec, leg, shares, entry_price,
                                cost, fair_at_entry, delta_per_share, expiry, opened_at, adopted, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'open')
         RETURNING id`,
        [
          this.portfolioId,
          p.marketId,
          p.asset,
          p.intervalSec,
          p.leg,
          p.shares,
          p.entryPrice,
          p.cost,
          p.fairAtEntry,
          p.deltaPer1PctPerShare,
          at(p.expiry),
          at(p.openedAt),
          p.adopted ?? false,
        ],
      );
      // Hand the id back to the in-memory position, so the next save updates
      // this row rather than inserting a second one.
      p.id = inserted.rows[0]!.id;
      await this.link(c, p.id, p.openedBy, "open");
    }
  }

  /**
   * Record that an execution acted on a position.
   *
   * This is the join that makes a closed position traceable to the transactions
   * that produced it. It exists because the two ids only come together here:
   * the execution is written before anything is signed, the position gets its
   * id when it is first persisted, and nothing else in the system holds both.
   *
   * `ON CONFLICT DO NOTHING` because a position saved twice in a cycle would
   * otherwise fail on the primary key, and re-recording a link is a no-op.
   */
  private async link(
    c: PoolClient,
    positionId: string,
    executionId: string | undefined,
    role: "open" | "increase" | "reduce" | "close" | "claim",
  ): Promise<void> {
    if (!executionId) return;
    await c.query(
      `INSERT INTO position_executions (position_id, execution_id, role) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [positionId, executionId, role],
    );
  }

  /**
   * Close whatever moved into `state.closed` since the last save.
   *
   * A closed entry carries the id of the position it came from, and that id is
   * NOT enough to decide what to do with the row — because a REDUCE produces a
   * closed entry for the part that was sold while the position itself stays
   * open, holding the same id.
   *
   * Closing the row on the strength of the id alone therefore deleted the
   * surviving lot: the row was marked closed and resized to the sold slice, and
   * on the next reload the remainder was simply gone. Measured on a live run —
   * one REDUCE of 0.66 shares, and the very next cycle repaired the ledger by
   * -0.31, which is precisely the remainder's cost.
   *
   * So the id is only followed when the position is genuinely finished, which is
   * exactly the case where it no longer appears in `state.open`. A partial sale
   * falls through to an insert and gets a row of its own — which is also the
   * more honest record, since two slices of one position sold at two prices are
   * two events.
   */
  private async persistClosed(c: PoolClient, state: RivoState): Promise<void> {
    const stillOpen = new Set(state.open.map((p) => p.id).filter(Boolean) as string[]);
    for (const p of state.closed.slice(this.closedWatermark)) {
      if (p.id && !stillOpen.has(p.id)) {
        const closed = await c.query(
          `UPDATE positions
              SET status = 'closed', closed_at = $3, won = $4, proceeds = $5, exit = $6,
                  shares = $7, cost = $8
            WHERE id = $2 AND portfolio_id = $1 AND status = 'open'`,
          [this.portfolioId, p.id, at(p.closedAt), p.won === 1, p.proceeds, p.exit, p.shares, p.cost],
        );
        if (closed.rowCount !== 0) {
          for (const executionId of p.closedBy ?? []) await this.link(c, p.id, executionId, "close");
          continue;
        }
      }
      // No row to close: a position opened and ended inside one cycle, or a
      // partial sale, which leaves the original open and needs a record of the
      // part that left.
      const row = await c.query<{ id: string }>(
        `INSERT INTO positions (portfolio_id, market_id, asset, interval_sec, leg, shares, entry_price,
                                cost, fair_at_entry, delta_per_share, expiry, opened_at,
                                status, closed_at, won, proceeds, exit)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, $10, $11, 'closed', $12, $13, $14, $15)
         RETURNING id`,
        [
          this.portfolioId,
          p.marketId,
          p.asset,
          p.intervalSec,
          p.leg,
          p.shares,
          p.entryPrice,
          p.cost,
          p.fairAtEntry,
          at(p.closedAt),
          at(p.openedAt),
          at(p.closedAt),
          p.won === 1,
          p.proceeds,
          p.exit,
        ],
      );
      for (const executionId of p.closedBy ?? []) await this.link(c, row.rows[0]!.id, executionId, "close");
    }
  }
}

/** The decision log for one portfolio. Append-only, enforced by a trigger. */
export class PostgresDecisionLog implements DecisionSink {
  constructor(readonly portfolioId: string) {}

  async append(records: DecisionRecord[]): Promise<void> {
    if (records.length === 0) return;
    // One statement for the whole cycle. A cycle produces up to sixteen legs and
    // a round-trip each would put the network on the hot path of every pass.
    const values: unknown[] = [];
    const rows = records.map((r, i) => {
      const b = i * 13;
      values.push(
        this.portfolioId,
        r.cycle,
        at(r.at),
        r.marketId,
        r.asset,
        r.intervalSec,
        r.leg,
        r.action,
        Number.isFinite(r.fair) ? r.fair : null,
        r.ask,
        r.edge,
        r.shares,
        r.cost,
      );
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9}, $${b + 10}, $${b + 11}, $${b + 12}, $${b + 13}, $${records.length * 13 + i + 1})`;
    });
    values.push(...records.map((r) => r.binding));
    await query(
      `INSERT INTO decisions (portfolio_id, cycle, at, market_id, asset, interval_sec, leg, action,
                              fair, ask, edge, shares, cost, binding)
       VALUES ${rows.join(", ")}`,
      values,
    );
  }

  async read(limit = 500): Promise<DecisionRecord[]> {
    const rows = await query<{
      cycle: string;
      at: Date;
      market_id: string;
      asset: string;
      interval_sec: number;
      leg: string;
      action: string;
      fair: string | null;
      ask: string | null;
      edge: string | null;
      shares: string | null;
      cost: string | null;
      binding: string;
    }>(
      `SELECT cycle, at, market_id, asset, interval_sec, leg, action, fair, ask, edge, shares, cost, binding
         FROM decisions WHERE portfolio_id = $1 ORDER BY at DESC, id DESC LIMIT $2`,
      [this.portfolioId, Math.min(5000, Math.max(1, limit))],
    );
    return rows
      .map((r) => ({
        at: secs(r.at),
        cycle: Number(r.cycle),
        marketId: r.market_id,
        asset: r.asset as Asset,
        intervalSec: r.interval_sec,
        leg: r.leg as Leg,
        action: r.action,
        fair: r.fair === null ? NaN : Number(r.fair),
        ask: r.ask === null ? null : Number(r.ask),
        edge: r.edge === null ? null : Number(r.edge),
        shares: num(r.shares),
        cost: num(r.cost),
        binding: r.binding,
      }))
      .reverse();
  }

  async count(): Promise<number> {
    const r = await one<{ n: string }>("SELECT count(*)::text AS n FROM decisions WHERE portfolio_id = $1", [
      this.portfolioId,
    ]);
    return Number(r.n);
  }
}
