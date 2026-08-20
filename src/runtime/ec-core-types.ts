// The slice of `@dreamdex-bot-kit/ec-core` that Rivo's live executor calls.
//
// Declared here rather than imported so the repository installs and runs
// STANDALONE. `ec-core` ships as raw TypeScript from a private workspace inside
// the official bot kit, so depending on it directly would mean anyone cloning
// this repo needs the kit checked out at a specific relative path before
// `npm install` will even complete — for a dependency that only the live trading
// path touches, and that every read-only command (calibrate, scan, allocate,
// backtest, the whole dry-run runtime) never loads at all.
//
// So the executor imports it dynamically, at the moment it first needs a signer,
// and type-checks against this contract in the meantime. The tradeoff is real
// and worth naming: this interface can drift from the kit's actual exports
// without the compiler noticing. It is kept deliberately small for that reason,
// and `npm run check:kit` verifies every name below still exists in an installed
// copy of the kit.

/** Opaque handles — Rivo never inspects these, it only passes them back. */
export type EcContext = unknown;
export type UnifiedMarket = { symbol?: string; info?: { marketId?: string } };
/** Only the fields Rivo reads. `pool` is the contract that escrows collateral. */
export type MarketOnchain = { pool?: `0x${string}` };

export interface PlaceLimitArgs {
  market: UnifiedMarket;
  onchain: MarketOnchain;
  outcome: "YES" | "NO";
  side: "buy" | "sell";
  price: number;
  size: number;
  type?: "post-only" | "ioc" | "limit";
  expiresInSec?: number;
}

export interface PlacedOrder {
  rested: boolean;
  orderId?: bigint;
  filled: number;
  size: number;
  price: number;
  hash?: string;
}

/** Exactly the exports the live executor uses. Keep in sync via `npm run check:kit`. */
export interface EcCore {
  createExchange(opts?: { withSigner?: boolean }): EcContext;
  activeMarkets(ctx: EcContext, opts?: { asset?: string; max?: number }): Promise<UnifiedMarket[]>;
  marketOnchain(ctx: EcContext, market: UnifiedMarket): Promise<MarketOnchain | null>;
  isTradable(onchain: MarketOnchain): boolean;
  sellableSize(ctx: EcContext, onchain: MarketOnchain, outcome: "YES" | "NO", want: number): Promise<number>;
  placeLimit(ctx: EcContext, args: PlaceLimitArgs): Promise<PlacedOrder>;
  clampProbability(p: number, lo?: number, hi?: number): number;
  seedInventory(ctx: EcContext, market: UnifiedMarket, onchain: MarketOnchain): Promise<void>;
  maybeClaim(ctx: EcContext, opts?: Record<string, unknown>): Promise<void>;
}

/** Every name this file promises. `check:kit` asserts the kit still exports them. */
export const EC_CORE_EXPORTS = [
  "createExchange",
  "activeMarkets",
  "marketOnchain",
  "isTradable",
  "sellableSize",
  "placeLimit",
  "clampProbability",
  "seedInventory",
  "maybeClaim",
] as const;

/** Where the kit is expected to live, unless RIVO_EC_CORE points elsewhere. */
export const DEFAULT_EC_CORE_SPECIFIER = "@dreamdex-bot-kit/ec-core";

/**
 * Load `ec-core` on demand.
 *
 * The specifier goes through a variable so the bundler and type-checker do not
 * try to resolve a package that is legitimately absent. A missing kit is a
 * configuration problem, not a crash, and the message says exactly how to fix it.
 */
export async function loadEcCore(): Promise<EcCore> {
  const specifier = process.env.RIVO_EC_CORE ?? DEFAULT_EC_CORE_SPECIFIER;
  try {
    const mod = (await import(/* @vite-ignore */ specifier)) as unknown as EcCore;
    for (const name of EC_CORE_EXPORTS) {
      if (typeof (mod as unknown as Record<string, unknown>)[name] !== "function") {
        throw new Error(`"${specifier}" is missing export "${name}"`);
      }
    }
    return mod;
  } catch (e) {
    throw new Error(
      `Live trading needs the official bot kit, which is not installed.\n` +
        `  reason: ${e instanceof Error ? e.message : String(e)}\n` +
        `  fix:    clone https://github.com/somnia-chain/dreamdex-bot-kit next to this repo, run\n` +
        `          \`npm install\` inside it, then \`npm run link:kit\` here.\n` +
        `  note:   every read-only command (calibrate, scan, allocate, backtest, report,\n` +
        `          and the whole dry-run runtime) works without it.`,
    );
  }
}
