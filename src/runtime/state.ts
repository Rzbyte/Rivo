// Durable portfolio state.
//
// A bot that runs unattended for days will be restarted — by a deploy, a crash,
// an OOM, a Railway shuffle. What it must never do is come back up believing it
// holds nothing and buy a second copy of everything it already owns. So state is
// written after every mutation, and startup RECONCILES rather than trusts:
// positions whose windows have settled are resolved, and anything the chain
// disagrees with loses to the chain.
//
// The decision log is not diagnostics. It is the forward-test record — every leg
// considered, priced, and accepted or refused, with the constraint that bound.
// Accumulated over days it becomes the only evidence that the portfolio layer
// behaves the way the backtest says it does, on data nobody could have fitted to.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Asset } from "../core/config.js";
import type { Leg } from "../engine/book.js";
import type { Position } from "../portfolio/risk.js";

export const STATE_VERSION = 1;

/** One position, plus what we need to resolve it after settlement. */
export interface HeldPosition extends Position {
  /**
   * Stable identity, assigned by whichever store persists this position.
   *
   * The file store has no use for one — a position is identified by its place in
   * an array it rewrites whole. A database does: it needs to know that the row
   * it wrote last cycle and the object it is holding now are the same position,
   * so that an execution can be linked to it and so that an update is an update
   * rather than a second position in the same leg.
   *
   * Optional, and the engine never reads it. Nothing in allocation, risk or
   * position management may depend on a position having been persisted.
   */
  id?: string;
  /** Unix seconds when the position was opened. */
  openedAt: number;
  /** Model probability at entry — what we believed when we paid. */
  fairAtEntry: number;
  /** Tx hash, when live. Absent in dry runs. */
  txHash?: string;
  /**
   * The execution ledger row that opened this position.
   *
   * Carried on the position so that whichever store persists it can record the
   * link — the position's id and the execution's id only exist together at that
   * moment. Without it, `position_executions` stays empty and a closed
   * position's audit trail is a list of no transactions, which is the exact
   * defect the ledger was built to fix.
   */
  openedBy?: string;
  /** True once the window settled and the payout was accounted for. */
  resolved?: boolean;
  /**
   * Set when the position was discovered on-chain rather than opened by Rivo.
   *
   * Its entry price is an ESTIMATE — nothing on-chain records what was paid — so
   * any P&L involving it is only as good as the mark used at adoption. Reports
   * must say so rather than presenting a guess as a fill.
   */
  adopted?: boolean;
}

/** A settled position, kept for the performance record. */
export interface ClosedPosition {
  /** The same identity the position carried while it was open, when a store assigned one. */
  id?: string;
  marketId: string;
  asset: Asset;
  /** Series cadence, kept so the performance report can break results down by tenor. */
  intervalSec: number;
  leg: Leg;
  shares: number;
  entryPrice: number;
  cost: number;
  fairAtEntry: number;
  openedAt: number;
  closedAt: number;
  /** 1 if the leg paid out. */
  won: 0 | 1;
  /** Collateral received: `shares` if won, else 0. Or the sale proceeds on an exit. */
  proceeds: number;
  /** Execution ledger rows that ended this position — a sale, a merge, a claim. */
  closedBy?: string[];
  /**
   * How the position ended.
   *
   * `dropped` is distinct from `voided` on purpose: a voided market paid nobody,
   * while a dropped position is one reconciliation removed because the chain
   * says the wallet never held it. Collapsing them would hide the only signal
   * that local state and the chain had diverged.
   */
  exit: "settled" | "sold" | "merged" | "voided" | "dropped";
}

/** One cycle's worth of reasoning, for the forward-test record. */
export interface DecisionRecord {
  at: number;
  cycle: number;
  marketId: string;
  asset: Asset;
  intervalSec: number;
  leg: Leg;
  action: string;
  fair: number;
  ask: number | null;
  edge: number | null;
  shares: number;
  cost: number;
  /** The constraint that determined the outcome. */
  binding: string;
  /**
   * What this decision did to correlated exposure, in collateral per 1% move.
   *
   * The arithmetic behind Rivo's most important refusal. A leg can have positive
   * edge and still be wrong to take, because the portfolio already holds the
   * same directional view at another tenor — and "already holds" is a number,
   * not an opinion. `after` equals `before` for a refusal, which is exactly what
   * makes a SKIP worth showing.
   *
   * Absent when the decision was reached before the delta budget was consulted:
   * a leg with no offer, or a window inside its expiry headroom, has no exposure
   * arithmetic to report and zero would misrepresent that.
   */
  exposure?: { before: number; after: number; cap: number };
}

export interface RivoState {
  version: number;
  /** Capital the user committed. */
  capital: number;
  /** Uncommitted collateral. */
  cash: number;
  /** Realised profit and loss since inception. */
  realizedPnl: number;
  open: HeldPosition[];
  closed: ClosedPosition[];
  cycles: number;
  startedAt: number;
  lastCycleAt: number;
  lastClaimSweepAt: number;
  /** Set when a circuit breaker has halted trading, with the reason. */
  halted: string | null;
  /** Peak equity seen, for drawdown tracking. */
  peakEquity: number;
  profile: string;
  dryRun: boolean;
  /**
   * The account this state was traded from, recorded the first time a live cycle
   * learns it.
   *
   * Without it, anything reading a state file after the fact has to assume the
   * wallet configured *now* is the wallet that produced *then* — and that
   * assumption broke the moment agent wallets arrived: `npm run proof` against a
   * finished run reported the balances of a wallet that had never touched it.
   * Optional, because states written before this existed are still valid.
   */
  tradedBy?: string;
  /**
   * Net value of positions ADOPTED from the chain that Rivo never bought, at the
   * marks they were adopted on, minus any dropped again.
   *
   * It exists so the cash ledger can balance without lying about either number.
   * Reconciliation can hand the portfolio a position it has no record of paying
   * for — a leftover from another process on the same wallet, or a manual trade.
   * Crediting the eventual payout to `cash` with no matching debit inflates cash
   * without limit, which is exactly what happened on a live run: 451.76 of cash
   * against 50 of allocated capital.
   *
   * Kept SEPARATE from `capital` on purpose. Capital is what the user authorised
   * and every risk budget is a fraction of it, so folding adopted assets into it
   * would let a stray token found on the wallet quietly raise Rivo's own risk
   * limits. Adopted positions still consume the delta budget, so finding one
   * makes Rivo more conservative, never less.
   */
  contributed?: number;
  /**
   * Unix seconds of the last trade in each leg, keyed `marketId:leg`.
   *
   * Guards against the one loop that costs money without changing anything: the
   * position manager sells into the bid because conviction fell, and the
   * allocator immediately buys back at the ask because the leg is under target.
   * Each round of that donates the spread. The kit's strategies carry the same
   * guard as OF_COOLDOWN_MS.
   */
  lastTradedAt?: Record<string, number>;
  /**
   * Consecutive failed order attempts per leg, keyed `marketId:leg`.
   *
   * `lastTradedAt` only records SUCCESS, so a leg whose orders keep reverting
   * had no cooldown at all and was retried every cycle forever. Measured on a
   * live canary: one stuck 0.56-share position produced 22 errors across 110
   * cycles, and because the failure aborted the whole cycle, everything after it
   * — allocation, settlement, claiming — was skipped on each of those passes.
   *
   * Cleared on the first success, so a leg that recovers is not punished for a
   * transient failure.
   */
  failures?: Record<string, { count: number; lastAt: number }>;
}

/**
 * The ledger identity every mutation must preserve.
 *
 * Cash plus what is tied up in open positions equals what was put in plus what
 * has been realised. Any path that moves one side without the other is an
 * accounting bug, and on a live portfolio it is invisible until the equity curve
 * is already wrong.
 */
export const ledgerImbalance = (s: RivoState): number =>
  s.cash + s.open.reduce((a, p) => a + p.cost, 0) - (s.capital + (s.contributed ?? 0) + s.realizedPnl);

/** Whether the ledger balances, within float tolerance scaled to the size of the book. */
export function ledgerBalances(s: RivoState): boolean {
  const scale = Math.max(1, Math.abs(s.capital) + Math.abs(s.realizedPnl));
  return Math.abs(ledgerImbalance(s)) <= 1e-6 * scale;
}

/**
 * Make a state written before the ledger identity was enforced balance again.
 *
 * State files exist that predate this rule — one live run drifted 426 of phantom
 * cash into them — and there is no way to reconstruct which mutation lost the
 * money. What CAN be done is stop the lie propagating: absorb the difference
 * into `contributed`, where it is visible and clearly labelled, rather than
 * leaving it hidden inside `cash` where every downstream number inherits it.
 *
 * Loud on purpose. A silent repair is how the original bug survived as long as
 * it did, and the resulting P&L should be treated as suspect for that portfolio.
 */
export function repairLedger(state: RivoState, warn: (msg: string) => void): RivoState {
  if (ledgerBalances(state)) {
    state.contributed ??= 0;
    return state;
  }
  const drift = ledgerImbalance(state);
  state.contributed = (state.contributed ?? 0) + drift;
  warn(
    `LEDGER REPAIRED: cash + open cost exceeded capital + realised by ${drift.toFixed(2)}. ` +
      `Absorbed into contributed. This state predates the reconciliation fix — P&L before now is unreliable.`,
  );
  return state;
}

export function emptyState(capital: number, profile: string, dryRun: boolean): RivoState {
  const now = Math.floor(Date.now() / 1000);
  return {
    version: STATE_VERSION,
    capital,
    contributed: 0,
    cash: capital,
    realizedPnl: 0,
    open: [],
    closed: [],
    cycles: 0,
    startedAt: now,
    lastCycleAt: 0,
    lastClaimSweepAt: 0,
    halted: null,
    peakEquity: capital,
    profile,
    dryRun,
    lastTradedAt: {},
  };
}

export class StateStore {
  constructor(readonly path: string) {}

  load(fallback: () => RivoState): RivoState {
    if (!existsSync(this.path)) return fallback();
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as RivoState;
      if (raw.version !== STATE_VERSION) {
        throw new Error(`state file is version ${raw.version}, this build writes ${STATE_VERSION}`);
      }
      return repairLedger(raw, (m) => console.warn(m));
    } catch (e) {
      // Refuse to silently start fresh. A corrupt or stale state file next to a
      // wallet holding real positions is exactly when starting from zero does
      // the most damage — it would re-buy everything already held.
      throw new Error(
        `cannot read state at ${this.path}: ${e instanceof Error ? e.message : String(e)}. ` +
          `Move it aside deliberately if you intend to start fresh.`,
      );
    }
  }

  /**
   * Write atomically.
   *
   * A torn state file is worse than none: it fails the load above and stops the
   * bot, which is right, but it also loses the position record. Write to a
   * sibling and rename, which is atomic on any sane filesystem.
   */
  save(state: RivoState): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, this.path);
  }
}

/** Append-only decision log, one JSON object per line. */
/**
 * Roll the decision log at this size, keeping one previous generation.
 *
 * The log is the forward-test record and was deliberately unbounded, which is
 * the right instinct and the wrong outcome for something meant to run
 * unattended: measured at ~3.6KB a cycle, a 45-second cadence writes ~7MB a day
 * and fills a container volume in months. A trading process that dies of a full
 * disk dies holding positions, and it dies at the worst possible moment —
 * whenever the disk happens to fill, which is not correlated with anything.
 *
 * 64MB of history plus one rolled generation is ~35,000 cycles, comfortably more
 * than any run this has had, and it is bounded. `RIVO_LOG_MAX_BYTES=0` restores
 * the old unbounded behaviour for anyone who would rather keep everything and
 * watch the disk themselves.
 */
const logMaxBytes = (): number => {
  const raw = Number(process.env.RIVO_LOG_MAX_BYTES ?? 64 * 1024 * 1024);
  return Number.isFinite(raw) ? raw : 64 * 1024 * 1024;
};

export class DecisionLog {
  constructor(readonly path: string) {}

  append(records: DecisionRecord[]): void {
    if (records.length === 0) return;
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.rollIfLarge();
    const lines = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
    writeFileSync(this.path, lines, { flag: "a" });
  }

  /**
   * Rename the log aside once it passes the cap.
   *
   * Rename rather than truncate, so the boundary never lands mid-record and a
   * reader is never handed half a line. Failure here is swallowed on purpose:
   * losing rotation costs disk eventually, while throwing would abort the cycle
   * that was about to record what it just did with real money.
   */
  private rollIfLarge(): void {
    const cap = logMaxBytes();
    if (cap <= 0) return;
    try {
      if (!existsSync(this.path) || statSync(this.path).size < cap) return;
      renameSync(this.path, `${this.path}.1`);
    } catch {
      /* keep writing; a log that cannot roll is better than a cycle that cannot record */
    }
  }

  /**
   * The most recent `maxRecords` decisions.
   *
   * Reads BACKWARDS from the end of the file rather than loading it whole. This
   * log grows without bound by design — it is the forward-test record — and at
   * one cycle a minute over sixteen legs it reaches hundreds of thousands of
   * entries in a couple of weeks. Every reader (the dashboard, the report) wants
   * the recent tail, so loading megabytes to slice the last few hundred lines
   * would make a long, healthy run the thing that breaks the UI.
   *
   * Pass `Infinity` to read everything, which only the analysis paths should do.
   */
  read(maxRecords = 5_000): DecisionRecord[] {
    if (!existsSync(this.path)) return [];
    const text = maxRecords === Infinity ? readFileSync(this.path, "utf8") : this.tail(maxRecords);
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    const wanted = maxRecords === Infinity ? lines : lines.slice(-maxRecords);
    return wanted.flatMap((l) => {
      try {
        return [JSON.parse(l) as DecisionRecord];
      } catch {
        return []; // a partial line — a truncated first one, or the last after a hard kill
      }
    });
  }

  /**
   * How many decisions have EVER been recorded.
   *
   * Counted rather than derived from `read()`, which now returns only a tail.
   * The cumulative figure is the one a reader is told, so it has to be the real
   * one — a count that quietly caps at the tail size would understate the record
   * exactly as it grows most interesting.
   */
  count(): number {
    if (!existsSync(this.path)) return 0;
    const fd = openSync(this.path, "r");
    try {
      const buf = Buffer.allocUnsafe(1 << 20);
      let total = 0;
      let read = 0;
      let pos = 0;
      let lastByte = 0;
      while ((read = readSync(fd, buf, 0, buf.length, pos)) > 0) {
        for (let i = 0; i < read; i++) if (buf[i] === 0x0a) total++;
        lastByte = buf[read - 1]!;
        pos += read;
      }
      // A final line without a trailing newline still counts.
      return pos > 0 && lastByte !== 0x0a ? total + 1 : total;
    } finally {
      closeSync(fd);
    }
  }

  /** Read enough trailing bytes to be confident they contain `maxRecords` lines. */
  private tail(maxRecords: number): string {
    const size = statSync(this.path).size;
    // Records are a few hundred bytes; 512 with a floor gives generous headroom
    // without reading the whole file for a modest request.
    const want = Math.min(size, Math.max(64 * 1024, maxRecords * 512));
    const fd = openSync(this.path, "r");
    try {
      const buf = Buffer.allocUnsafe(want);
      readSync(fd, buf, 0, want, size - want);
      const text = buf.toString("utf8");
      // Drop the first line unless we happened to start at a record boundary:
      // reading mid-file almost certainly lands mid-record.
      const nl = text.indexOf("\n");
      return want < size && nl >= 0 ? text.slice(nl + 1) : text;
    } finally {
      closeSync(fd);
    }
  }
}

/** Total equity: cash plus what open positions cost. */
export const equityOf = (s: RivoState): number => s.cash + s.open.reduce((n, p) => n + p.cost, 0);

export const defaultDataDir = (): string => process.env.RIVO_DATA_DIR ?? join(process.cwd(), "data");
export const statePath = (dir = defaultDataDir()): string => join(dir, "state.json");
export const decisionLogPath = (dir = defaultDataDir()): string => join(dir, "decisions.jsonl");
