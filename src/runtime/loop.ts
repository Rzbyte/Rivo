// The autonomous cycle.
//
//   DISCOVER -> RECONCILE -> SETTLE / CLAIM -> MONITOR / RECOVER
//            -> RISK CHECK -> ALLOCATE -> EXECUTE
//
// Ordering is not arbitrary. Settlement runs BEFORE allocation so that capital
// freed by a window that just resolved is available in the same pass rather than
// the next one — on a venue where a 15-minute window rolls every quarter hour,
// waiting a cycle to redeploy is a meaningful drag. Position management runs
// before allocation for the same reason: capital released by an exit should be
// spendable immediately.
//
// Claiming deserves its own note. A settled window pays out only when somebody
// asks it to; the position does not decay into collateral on its own. So a bot
// that trades for a week without claiming has its balance spread across dozens
// of finalised windows while its wallet reads near zero. Claiming runs INSIDE
// the loop rather than on a timer because it signs with the same key that
// trades, and two senders on one key race each other's nonce.

import { Indexer } from "../core/indexer.js";
import type { Asset } from "../core/config.js";
import { snapshot, type Snapshot } from "../engine/scan.js";
import { allocate } from "../portfolio/allocator.js";
import type { RiskProfile } from "../portfolio/profiles.js";
import { measureCorrelation, type Position } from "../portfolio/risk.js";
import { legKey, manage, type PositionDecision } from "./position.js";
import { describe as describeDiscrepancy, reconcile, type Discrepancy } from "./reconcile.js";
import type { Executor } from "./executor.js";
import {
  DecisionLog,
  equityOf,
  StateStore,
  type ClosedPosition,
  type DecisionRecord,
  type HeldPosition,
  type RivoState,
} from "./state.js";

export interface LoopDeps {
  idx: Indexer;
  executor: Executor;
  store: StateStore;
  log: DecisionLog;
  profile: RiskProfile;
  out: (line: string) => void;
}

export interface CycleReport {
  cycle: number;
  at: number;
  /** Corrections applied because the chain disagreed with our records. */
  reconciled: Discrepancy[];
  windows: number;
  legs: number;
  settled: number;
  claimed: number;
  managed: PositionDecision[];
  bought: number;
  spent: number;
  equity: number;
  cash: number;
  halted: string | null;
  rho: number;
}

/** Sweep settled windows at most this often — it costs a signature each time. */
const CLAIM_INTERVAL_SEC = 600;

/** Halt if equity falls this far below its peak. */
const MAX_DRAWDOWN = 0.35;

/** Minimum gap between trades in one leg. Long enough to outlast a model wobble. */
const LEG_COOLDOWN_SEC = 180;

export async function cycle(state: RivoState, deps: LoopDeps): Promise<CycleReport> {
  const { idx, executor, store, log, profile, out } = deps;
  const now = Math.floor(Date.now() / 1000);
  state.cycles++;
  state.lastCycleAt = now;
  const records: DecisionRecord[] = [];

  // --- DISCOVER + ANALYZE ------------------------------------------------
  // First, because reconciliation needs it. Adopting a position the chain holds
  // and Rivo does not requires knowing the window's asset, cadence and expiry —
  // a position without an expiry can never be managed or settled — and all of
  // that lives in the snapshot. Pricing is independent of what we hold, so
  // running it before reconciliation costs nothing.
  const snap: Snapshot = await snapshot(idx, { minEdge: profile.minEdge, now });
  const spot = new Map<Asset, number>();
  for (const [a, s] of snap.assets) spot.set(a, s.spot);
  const rho = measureCorrelation(snap.assets.get("BTC")?.bars ?? [], snap.assets.get("ETH")?.bars ?? []);

  const oppByLeg = new Map(snap.opportunities.map((o) => [legKey(o.marketId, o.leg), o]));

  // --- RECONCILE ---------------------------------------------------------
  // Make the chain the authority on what is held, before anything reasons from
  // it. Settlement, position management and allocation all read `state.open`,
  // so a stale picture makes every one of them wrong in the same direction.
  //
  // Dry runs skip this: simulated positions have no on-chain counterpart, and
  // checking them against a chain that never heard of them would delete the
  // entire portfolio. `executor.address()` returning null IS that signal.
  let reconciled: Discrepancy[] = [];
  const account = await executor.address();
  if (account) {
    const meta = new Map<string, { asset: Asset; intervalSec: number; expiry: number; fair: number }>();
    const marks = new Map<string, number>();
    for (const o of snap.opportunities) {
      const k = `${o.marketId.toLowerCase()}:${o.leg}`;
      meta.set(k, { asset: o.asset, intervalSec: o.intervalSec, expiry: o.expiry, fair: o.fair });
      // Mark an adopted position at the model's own fair value rather than at
      // the ask. Nothing on-chain records what was paid, so any figure here is a
      // guess; fair value is the neutral one — it opens the position at zero
      // unrealised P&L instead of inventing an instant gain or loss.
      if (Number.isFinite(o.fair)) marks.set(k, o.fair);
    }
    const chain = await idx.outcomeBalances(account);
    reconciled = reconcile({ state, chain, meta, marks, now });
    for (const d of reconciled) out(`  ${describeDiscrepancy(d)}`);
    if (reconciled.length > 0) store.save(state);
  }

  // --- SETTLE ------------------------------------------------------------
  // Resolve anything whose window has ended, now that holdings are trustworthy.
  const settled = await resolveSettled(state, idx, now, out);

  // --- CLAIM -------------------------------------------------------------
  let claimed = 0;
  if (now - state.lastClaimSweepAt > CLAIM_INTERVAL_SEC) {
    claimed = await executor.claim();
    state.lastClaimSweepAt = now;
  }

  // --- MONITOR (+ RECOVER) ------------------------------------------------
  const managed = manage({
    positions: state.open,
    opportunities: oppByLeg,
    books: snap.books,
    profile,
    now,
    lastTradedAt: state.lastTradedAt ?? {},
    cooldownSec: LEG_COOLDOWN_SEC,
  });
  for (const d of managed) {
    if (d.action === "HOLD") continue;
    await applyPositionAction(state, d, snap, executor, out, records, now);
  }

  // --- RISK CHECK ---------------------------------------------------------
  const equity = equityOf(state);
  state.peakEquity = Math.max(state.peakEquity, equity);
  const drawdown = state.peakEquity > 0 ? (state.peakEquity - equity) / state.peakEquity : 0;
  if (!state.halted && drawdown > MAX_DRAWDOWN) {
    // A circuit breaker that only stops NEW risk. Existing positions are left to
    // settle: dumping a book into a thin bid to honour a drawdown limit realises
    // the spread on top of the loss, which is the wrong way to stop bleeding.
    state.halted = `drawdown ${(drawdown * 100).toFixed(1)}% exceeded ${(MAX_DRAWDOWN * 100).toFixed(0)}% — no new positions; open ones will settle`;
    out(`HALTED: ${state.halted}`);
  }

  // --- ALLOCATE + EXECUTE -------------------------------------------------
  let bought = 0;
  let spent = 0;
  if (!state.halted) {
    const result = allocate({
      totalCapital: state.capital,
      freeCash: state.cash,
      opportunities: snap.opportunities,
      books: snap.books,
      spot,
      held: state.open as Position[],
      rho,
      profile,
    });

    for (const d of result.decisions) {
      const o = d.opportunity;
      if (d.action !== "BUY" || d.shares <= 0) {
        records.push(record(now, state.cycles, o, "SKIP", 0, 0, d.binding));
        continue;
      }
      const key = legKey(o.marketId, o.leg);
      const since = now - (state.lastTradedAt?.[key] ?? 0);
      if (since < LEG_COOLDOWN_SEC) {
        records.push(record(now, state.cycles, o, "SKIP", 0, 0, `cooling down (${LEG_COOLDOWN_SEC - since}s left) — traded this leg recently`));
        continue;
      }
      // Confirm on-chain that the window still accepts orders. The indexer lags
      // by seconds and only `Trading` accepts an order; acting on a stale row is
      // how a cycle burns gas on a locked market.
      if (!(await executor.isTradable(o.marketId))) {
        records.push(record(now, state.cycles, o, "SKIP", 0, 0, "not Trading on-chain at send time"));
        continue;
      }
      const res = await executor.buy(
        { marketId: o.marketId, leg: o.leg, size: d.shares, limitPrice: o.fair },
        snap.books.get(o.marketId),
      );
      if (res.filled <= 0) {
        records.push(record(now, state.cycles, o, "SKIP", 0, 0, res.rejected ?? "no fill"));
        continue;
      }
      const pos: HeldPosition = {
        marketId: o.marketId,
        asset: o.asset,
        intervalSec: o.intervalSec,
        leg: o.leg,
        shares: res.filled,
        entryPrice: res.avgPrice,
        cost: res.cost,
        expiry: o.expiry,
        deltaPer1PctPerShare: (spot.get(o.asset) ?? 0) * 0.01 * o.deltaPerShare,
        openedAt: now,
        fairAtEntry: o.fair,
        ...(res.txHash ? { txHash: res.txHash } : {}),
      };
      state.open.push(pos);
      state.cash -= res.cost;
      state.lastTradedAt = { ...(state.lastTradedAt ?? {}), [key]: now };
      // Persist NOW rather than at the end of the cycle. The gap between an
      // order filling on-chain and that fill being written down is exactly the
      // window in which a crash makes Rivo forget a position it owns — and then
      // buy a second copy. Reconciliation above repairs that after the fact;
      // saving here mostly prevents it.
      store.save(state);
      bought++;
      spent += res.cost;
      records.push(record(now, state.cycles, o, "BUY", res.filled, res.cost, d.binding));
      out(
        `  BUY  ${o.asset}-${Math.round(o.intervalSec / 60)}m ${o.leg}  ${res.filled.toFixed(2)} @ ${res.avgPrice.toFixed(3)}  ` +
          `cost ${res.cost.toFixed(2)}  (${d.binding})`,
      );
    }
  }

  log.append(records);
  store.save(state);

  return {
    cycle: state.cycles,
    at: now,
    reconciled,
    windows: snap.windows.length,
    legs: snap.opportunities.length,
    settled,
    claimed,
    managed,
    bought,
    spent,
    equity: equityOf(state),
    cash: state.cash,
    halted: state.halted,
    rho,
  };
}

/**
 * Resolve positions whose windows have ended.
 *
 * Voided windows redeem BOTH legs at 0.5 rather than paying one side — the
 * protocol's answer when no reliable settlement price exists. Scoring that as a
 * loss would slander the model; scoring it as a win would flatter it. It is
 * neither, and it gets its own exit type.
 *
 * Exported for testing: this is the only place collateral changes hands on an
 * outcome, so it is worth pinning directly rather than reaching it through a
 * full cycle that would need the venue mocked to get here.
 */
export async function resolveSettled(state: RivoState, idx: Indexer, now: number, out: (s: string) => void): Promise<number> {
  const due = state.open.filter((p) => p.expiry <= now);
  if (due.length === 0) return 0;

  const outcomes = await idx.outcomes([...new Set(due.map((p) => p.marketId))]);
  let resolved = 0;
  const remaining: HeldPosition[] = [];

  for (const p of state.open) {
    const o = outcomes.get(p.marketId.toLowerCase());
    if (p.expiry > now || !o || (!o.finalized && !o.voided)) {
      remaining.push(p);
      continue;
    }
    let proceeds: number;
    let won: 0 | 1;
    let exit: ClosedPosition["exit"];
    if (o.voided) {
      proceeds = p.shares * 0.5;
      won = 0;
      exit = "voided";
    } else {
      const upWon = o.winningOutcome === 0;
      won = (p.leg === "UP" ? upWon : !upWon) ? 1 : 0;
      proceeds = won === 1 ? p.shares : 0;
      exit = "settled";
    }
    state.cash += proceeds;
    state.realizedPnl += proceeds - p.cost;
    state.closed.push({
      marketId: p.marketId,
      asset: p.asset,
      intervalSec: p.intervalSec,
      leg: p.leg,
      shares: p.shares,
      entryPrice: p.entryPrice,
      cost: p.cost,
      fairAtEntry: p.fairAtEntry,
      openedAt: p.openedAt,
      closedAt: now,
      won,
      proceeds,
      exit,
    });
    resolved++;
    out(
      `  ${exit === "voided" ? "VOID" : won === 1 ? "WON " : "LOST"} ${p.asset}-${Math.round(p.intervalSec / 60)}m ${p.leg}  ` +
        `${p.shares.toFixed(2)} @ ${p.entryPrice.toFixed(3)}  ->  ${proceeds.toFixed(2)}  (${(proceeds - p.cost >= 0 ? "+" : "") + (proceeds - p.cost).toFixed(2)})`,
    );
  }
  state.open = remaining;
  return resolved;
}

async function applyPositionAction(
  state: RivoState,
  d: PositionDecision,
  snap: Snapshot,
  executor: Executor,
  out: (s: string) => void,
  records: DecisionRecord[],
  now: number,
): Promise<void> {
  const p = d.position;
  const book = snap.books.get(p.marketId);

  if (d.action === "RECOVER") {
    const res = await executor.mergeSet(p.marketId, d.size);
    if (res.filled <= 0) return;
    // A merge consumes equal shares of both legs and returns collateral 1:1.
    // Reduce this leg by the merged amount; its partner is reduced by its own
    // decision in the same pass.
    p.shares -= res.filled;
    const releasedCost = p.shares <= 0 ? p.cost : (p.cost * res.filled) / (p.shares + res.filled);
    p.cost -= releasedCost;
    state.cash += res.filled * 0.5; // each leg contributes half of the recovered unit
    if (p.shares <= 1e-9) state.open = state.open.filter((x) => x !== p);
    out(`  MERGE ${p.asset} ${p.leg} ${res.filled.toFixed(2)} -> collateral  (${d.reason})`);
    return;
  }

  if (d.action === "EXIT" || d.action === "REDUCE") {
    const res = await executor.sell(
      { marketId: p.marketId, leg: p.leg, size: d.size, limitPrice: d.limitPrice },
      book,
    );
    if (res.filled <= 0) return;
    const proceeds = -res.cost; // sell returns negative cost
    const costOut = (p.cost * res.filled) / p.shares;
    p.shares -= res.filled;
    p.cost -= costOut;
    state.cash += proceeds;
    state.realizedPnl += proceeds - costOut;
    state.closed.push({
      marketId: p.marketId,
      asset: p.asset,
      intervalSec: p.intervalSec,
      leg: p.leg,
      shares: res.filled,
      entryPrice: p.entryPrice,
      cost: costOut,
      fairAtEntry: p.fairAtEntry,
      openedAt: p.openedAt,
      closedAt: now,
      won: 0,
      proceeds,
      exit: "sold",
    });
    if (p.shares <= 1e-9) {
      state.open = state.open.filter((x) => x !== p);
    } else if (d.fairNow !== null) {
      // Re-baseline what is left. The stop has now acted on this move; leaving
      // the old entry value in place would have it fire again next cycle on the
      // same information.
      p.fairAtEntry = d.fairNow;
    }
    state.lastTradedAt = { ...(state.lastTradedAt ?? {}), [legKey(p.marketId, p.leg)]: now };
    records.push({
      at: now,
      cycle: state.cycles,
      marketId: p.marketId,
      asset: p.asset,
      intervalSec: p.intervalSec,
      leg: p.leg,
      action: d.action,
      fair: d.fairNow ?? NaN,
      ask: null,
      edge: null,
      shares: res.filled,
      cost: -proceeds,
      binding: d.reason,
    });
    out(`  ${d.action} ${p.asset}-${Math.round(p.intervalSec / 60)}m ${p.leg} ${res.filled.toFixed(2)} @ ${res.avgPrice.toFixed(3)}  (${d.reason})`);
  }
}

const record = (
  at: number,
  cycle: number,
  o: { marketId: string; asset: Asset; intervalSec: number; leg: "UP" | "DOWN"; fair: number; ask: number | null; edge: number | null },
  action: string,
  shares: number,
  cost: number,
  binding: string,
): DecisionRecord => ({
  at,
  cycle,
  marketId: o.marketId,
  asset: o.asset,
  intervalSec: o.intervalSec,
  leg: o.leg,
  action,
  fair: o.fair,
  ask: o.ask,
  edge: o.edge,
  shares,
  cost,
  binding,
});
