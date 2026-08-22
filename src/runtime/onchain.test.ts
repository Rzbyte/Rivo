// Reading holdings from the chain, and refusing to guess.
//
// This module exists because the indexer was wrong in both directions on a real
// wallet — two of five rows, measured 2026-08-22. Half of these tests are about
// getting the right number out of the chain; the other half are about the one
// way this code could be far more dangerous than the problem it fixes.
//
// A zero from here authorises reconciliation to DELETE a position. So "the RPC
// timed out" and "the wallet holds nothing" must never arrive at the caller
// looking alike. Every failure path is asserted to produce null, and the caller
// is asserted to leave the indexer's figure alone when it sees one.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { OutcomeReader } from "./onchain.js";
import { verifyAgainstChain } from "./loop.js";
import { emptyState, type HeldPosition } from "./state.js";

const POOL = "0x1111111111111111111111111111111111111111";
const TOKEN = "0x2222222222222222222222222222222222222222";
const OWNER = "0x3333333333333333333333333333333333333333";

const w = (hex: string) => hex.replace(/^0x/, "").padStart(64, "0");
/** A `getBinaryPoolParams()` return: the fields we read are at slots 2..5. */
const MKT = "0x4444444444444444444444444444444444444444";
const paramsReturn = (token = TOKEN, yes = 7n, no = 8n, one = 1_000_000n, market = MKT) =>
  "0x" + w("0xaaaa") + w(market) + w(token) + w(yes.toString(16)) + w(no.toString(16)) + w(one.toString(16)) +
  w("0x0").repeat(7) + w("0x1d") + w("0x0");
const uint = (v: bigint) => "0x" + w(v.toString(16));

/** A fetch that answers pool-params and balanceOf from a script. */
function rpc(answers: (body: { params: [{ to: string; data: string }] }) => unknown) {
  return vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { params: [{ to: string; data: string }] };
    const result = answers(body);
    if (result instanceof Error) throw result;
    return { json: async () => (result === undefined ? { error: "boom" } : { result }) };
  });
}

const original = globalThis.fetch;
beforeEach(() => vi.restoreAllMocks());
afterEach(() => {
  globalThis.fetch = original;
});

describe("reading a balance", () => {
  it("resolves the leg ids from the pool, then asks the outcome token", async () => {
    const seen: string[] = [];
    globalThis.fetch = rpc((b) => {
      const { to, data } = b.params[0];
      seen.push(to);
      if (to === POOL) return paramsReturn();
      // The id must be the YES id for an UP leg, and the owner must be encoded.
      expect(data.slice(0, 10)).toBe("0x00fdd58e");
      expect(data).toContain(OWNER.slice(2).toLowerCase());
      expect(data.endsWith(w("0x7"))).toBe(true);
      return uint(310_000n);
    }) as never;

    const balance = await new OutcomeReader("http://rpc.test").balance(POOL, OWNER, "UP");
    expect(balance).toBeCloseTo(0.31);
    expect(seen).toEqual([POOL, TOKEN]);
  });

  it("asks for the NO id on a DOWN leg", async () => {
    globalThis.fetch = rpc((b) =>
      b.params[0].to === POOL ? paramsReturn() : (expect(b.params[0].data.endsWith(w("0x8"))).toBe(true), uint(790_000n)),
    ) as never;
    expect(await new OutcomeReader("http://rpc.test").balance(POOL, OWNER, "DOWN")).toBeCloseTo(0.79);
  });

  it("scales by the pool's own oneCollateral rather than an assumed 1e6", async () => {
    // Mainnet collateral is 18 decimals. Hardcoding the testnet scale would put
    // every mainnet balance out by twelve orders of magnitude.
    globalThis.fetch = rpc((b) =>
      b.params[0].to === POOL ? paramsReturn(TOKEN, 7n, 8n, 10n ** 18n) : uint(5n * 10n ** 17n),
    ) as never;
    expect(await new OutcomeReader("http://rpc.test").balance(POOL, OWNER, "UP")).toBeCloseTo(0.5);
  });

  it("reads a genuine zero as zero", async () => {
    globalThis.fetch = rpc((b) => (b.params[0].to === POOL ? paramsReturn() : uint(0n))) as never;
    expect(await new OutcomeReader("http://rpc.test").balance(POOL, OWNER, "UP")).toBe(0);
  });

  it("resolves a pool's ids once, however many legs are asked for", async () => {
    let paramCalls = 0;
    globalThis.fetch = rpc((b) => {
      if (b.params[0].to === POOL) {
        paramCalls++;
        return paramsReturn();
      }
      return uint(1_000_000n);
    }) as never;
    const r = new OutcomeReader("http://rpc.test");
    await r.balance(POOL, OWNER, "UP");
    await r.balance(POOL, OWNER, "DOWN");
    expect(paramCalls).toBe(1);
  });
});

describe("a failure is never a zero", () => {
  it("returns null when the RPC throws", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as never;
    expect(await new OutcomeReader("http://rpc.test").balance(POOL, OWNER, "UP")).toBeNull();
  });

  it("returns null when the node answers with an error", async () => {
    globalThis.fetch = rpc(() => undefined) as never;
    expect(await new OutcomeReader("http://rpc.test").balance(POOL, OWNER, "UP")).toBeNull();
  });

  it("returns null when the balance call fails after the ids resolved", async () => {
    globalThis.fetch = rpc((b) => (b.params[0].to === POOL ? paramsReturn() : undefined)) as never;
    expect(await new OutcomeReader("http://rpc.test").balance(POOL, OWNER, "UP")).toBeNull();
  });

  it("returns null on a pool that answers with nonsense", async () => {
    globalThis.fetch = rpc((b) =>
      b.params[0].to === POOL ? "0x" + w("0x0").repeat(15) : uint(1n),
    ) as never;
    // oneCollateral of zero would divide every balance by nothing.
    expect(await new OutcomeReader("http://rpc.test").balance(POOL, OWNER, "UP")).toBeNull();
  });

  it("does not cache a single transport failure as a dead pool", async () => {
    let call = 0;
    globalThis.fetch = rpc((b) => {
      if (b.params[0].to !== POOL) return uint(1_000_000n);
      return ++call === 1 ? undefined : paramsReturn();
    }) as never;
    const r = new OutcomeReader("http://rpc.test");
    expect(await r.balance(POOL, OWNER, "UP")).toBeNull();
    // A blip must not make this process refuse the market for the rest of its life.
    expect(await r.balance(POOL, OWNER, "UP")).toBeCloseTo(1);
  });
});

describe("what the cycle does with the answer", () => {
  const held = (marketId: string, over: Partial<HeldPosition> = {}): HeldPosition => ({
    marketId,
    asset: "BTC",
    intervalSec: 900,
    leg: "UP",
    shares: 1,
    entryPrice: 0.5,
    cost: 0.5,
    expiry: 2_000_000_000,
    deltaPer1PctPerShare: 0.01,
    openedAt: 1_000_000,
    fairAtEntry: 0.5,
    ...over,
  });
  const stateWith = (open: HeldPosition[]) => ({ ...emptyState(50, "balanced", false), open });
  const MARKET = "0x4444444444444444444444444444444444444444";
  const idx = { poolsOf: async () => new Map([["0xmkt", { pool: POOL, marketAddress: MARKET }]]) };
  const reader = (value: number | null) => ({ balance: async () => value, newCycle: () => {} });

  it("overrides an indexer figure the chain contradicts", async () => {
    const out = await verifyAgainstChain(idx, new Map([["0xmkt:UP", 0.31]]), stateWith([]), OWNER, reader(0.07));
    expect(out.get("0xmkt:UP")).toBeCloseTo(0.07);
  });

  it("removes a holding the chain says was already burned", async () => {
    // The exact case seen live: a settled leg whose row lingered in the indexer
    // and was reported as an unclaimed payout on every single cycle.
    const out = await verifyAgainstChain(idx, new Map([["0xmkt:UP", 0.31]]), stateWith([]), OWNER, reader(0));
    expect(out.has("0xmkt:UP")).toBe(false);
  });

  it("finds a position the indexer has not caught up with yet", async () => {
    // Nothing in the indexer, but Rivo believes it holds this and the chain
    // agrees — which is what stops a fresh fill being dropped as phantom.
    const out = await verifyAgainstChain(idx, new Map(), stateWith([held("0xmkt")]), OWNER, reader(1.5));
    expect(out.get("0xmkt:UP")).toBeCloseTo(1.5);
  });

  it("leaves the indexer's figure alone when the chain cannot be read", async () => {
    const out = await verifyAgainstChain(idx, new Map([["0xmkt:UP", 0.31]]), stateWith([]), OWNER, reader(null));
    expect(out.get("0xmkt:UP")).toBeCloseTo(0.31);
  });

  it("leaves everything alone when the pool lookup fails", async () => {
    const broken = {
      poolsOf: async (): Promise<Map<string, { pool: string; marketAddress: string }>> => {
        throw new Error("indexer down");
      },
    };
    const from = new Map([["0xmkt:UP", 0.31]]);
    expect(await verifyAgainstChain(broken, from, stateWith([]), OWNER, reader(0))).toBe(from);
  });

  it("drops cached pool ids every cycle, because pools are recycled between windows", async () => {
    // The same address serves one window, then the next, and the leg ids move
    // with the generation. A cache that outlives a cycle eventually reports a
    // confident balance for the market a pool USED to be.
    let cleared = 0;
    await verifyAgainstChain(idx, new Map([["0xmkt:UP", 1]]), stateWith([]), OWNER, {
      balance: async () => 1,
      newCycle: () => {
        cleared++;
      },
    });
    expect(cleared).toBe(1);
  });

  it("skips a market with no known pool rather than deleting it", async () => {
    const none = { poolsOf: async () => new Map<string, { pool: string; marketAddress: string }>() };
    const out = await verifyAgainstChain(none, new Map([["0xmkt:UP", 0.31]]), stateWith([]), OWNER, reader(0));
    expect(out.get("0xmkt:UP")).toBeCloseTo(0.31);
  });
});

describe("a recycled pool cannot answer for a window it no longer serves", () => {
  // The regression this exists to stop, in full. Pools are handed from one
  // window to the next, and the leg ids go with them. Reading a finished
  // window's balance off its old pool therefore asks about somebody else's
  // token id, and the answer is a confident zero — which authorises a DROP.
  //
  // Measured on a live run before this check existed: four finalised windows
  // whose pools had already rolled (nonces 29, 29, 33, 48) each returned zero
  // for shares the wallet genuinely still held. The runtime wrote roughly seven
  // shares out of the ledger as phantom, the drawdown breaker fired at 39.9%,
  // and the tokens are still sitting on-chain unredeemed.
  const OTHER = "0x9999999999999999999999999999999999999999";

  it("returns null, not zero, when the pool has moved on", async () => {
    globalThis.fetch = rpc((b) => (b.params[0].to === POOL ? paramsReturn() : uint(0n))) as never;
    const r = new OutcomeReader("http://rpc.test");
    // Asking about the window the pool actually serves: answered.
    expect(await r.balance(POOL, OWNER, "UP", MKT)).toBe(0);
    // Asking about a different window on the same pool: refused.
    r.newCycle();
    expect(await r.balance(POOL, OWNER, "UP", OTHER)).toBeNull();
  });

  it("still answers when the caller names no window, for callers that cannot", async () => {
    globalThis.fetch = rpc((b) => (b.params[0].to === POOL ? paramsReturn() : uint(2_000_000n))) as never;
    expect(await new OutcomeReader("http://rpc.test").balance(POOL, OWNER, "UP")).toBeCloseTo(2);
  });

  it("leaves the position alone rather than dropping it, end to end", async () => {
    // The property that matters is not the null — it is that the cycle keeps
    // believing in a position the chain cannot be asked about.
    const rolled = {
      poolsOf: async () => new Map([["0xmkt", { pool: POOL, marketAddress: OTHER }]]),
    };
    const reader = {
      balance: async (_p: string, _o: string, _l: "UP" | "DOWN", market?: string) =>
        market && market.toLowerCase() !== MKT.toLowerCase() ? null : 0,
      newCycle: () => {},
    };
    const state = { ...emptyState(50, "balanced", false), open: [] as HeldPosition[] };
    const out = await verifyAgainstChain(rolled, new Map([["0xmkt:UP", 4.16]]), state, OWNER, reader);
    expect(out.get("0xmkt:UP")).toBeCloseTo(4.16);
  });
});
