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

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Asset } from "../core/config.js";
import type { Leg } from "../engine/book.js";
import type { Position } from "../portfolio/risk.js";

export const STATE_VERSION = 1;

/** One position, plus what we need to resolve it after settlement. */
export interface HeldPosition extends Position {
  /** Unix seconds when the position was opened. */
  openedAt: number;
  /** Model probability at entry — what we believed when we paid. */
  fairAtEntry: number;
  /** Tx hash, when live. Absent in dry runs. */
  txHash?: string;
  /** True once the window settled and the payout was accounted for. */
  resolved?: boolean;
}

/** A settled position, kept for the performance record. */
export interface ClosedPosition {
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
  /** How the position ended. */
  exit: "settled" | "sold" | "merged" | "voided";
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
   * Unix seconds of the last trade in each leg, keyed `marketId:leg`.
   *
   * Guards against the one loop that costs money without changing anything: the
   * position manager sells into the bid because conviction fell, and the
   * allocator immediately buys back at the ask because the leg is under target.
   * Each round of that donates the spread. The kit's strategies carry the same
   * guard as OF_COOLDOWN_MS.
   */
  lastTradedAt?: Record<string, number>;
}

export function emptyState(capital: number, profile: string, dryRun: boolean): RivoState {
  const now = Math.floor(Date.now() / 1000);
  return {
    version: STATE_VERSION,
    capital,
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
      return raw;
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
export class DecisionLog {
  constructor(readonly path: string) {}

  append(records: DecisionRecord[]): void {
    if (records.length === 0) return;
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const lines = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
    writeFileSync(this.path, lines, { flag: "a" });
  }

  read(): DecisionRecord[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as DecisionRecord];
        } catch {
          return []; // a partial final line after a hard kill is not worth dying over
        }
      });
  }
}

/** Total equity: cash plus what open positions cost. */
export const equityOf = (s: RivoState): number => s.cash + s.open.reduce((n, p) => n + p.cost, 0);

export const defaultDataDir = (): string => process.env.RIVO_DATA_DIR ?? join(process.cwd(), "data");
export const statePath = (dir = defaultDataDir()): string => join(dir, "state.json");
export const decisionLogPath = (dir = defaultDataDir()): string => join(dir, "decisions.jsonl");
