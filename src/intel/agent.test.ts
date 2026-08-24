// The boundary with somebody else's process.
//
// Every test here is a way a remote agent can be wrong, and the assertion is
// always the same: Rivo declines the trade and records why. An endpoint that is
// slow, hostile, or simply badly written must never take down a cycle that other
// portfolios are waiting on, and must never talk Rivo past its own limits.

import { describe, expect, it, vi } from "vitest";
import { askAgent, parseDecision, referenceAgent, skip, type EventContext } from "./agent.js";

const ctx = (over: Partial<EventContext> = {}): EventContext => ({
  market: { marketId: "0xm", asset: "BTC", leg: "UP", intervalSec: 900, expiry: 2_000, secondsLeft: 600 },
  price: { bid: 0.6, ask: 0.62, depth: 40 },
  reference: { spot: 64_000, probability: 0.7 },
  limits: { maxNotional: 5 },
  ...over,
});

const ok = (body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));

describe("parsing what came back", () => {
  it("accepts a well-formed decision", () => {
    const d = parseDecision({ action: "ENTER", probability: 0.7, confidence: 0.5, notional: 2, reason: "x" }, { maxNotional: 5 });
    expect(d).toEqual({ action: "ENTER", probability: 0.7, confidence: 0.5, notional: 2, reason: "x" });
  });

  it("caps a notional at the limit rather than refusing it", () => {
    // An agent asking for more than the limit is not an error. It is an agent
    // asking, and the answer is the limit.
    expect(parseDecision({ action: "ENTER", notional: 1_000_000 }, { maxNotional: 5 }).notional).toBe(5);
  });

  it("refuses an ENTER with no size", () => {
    for (const n of [undefined, null, 0, -1, "2", NaN, Infinity]) {
      const d = parseDecision({ action: "ENTER", notional: n }, { maxNotional: 5 });
      expect(d.action, `notional ${JSON.stringify(n)}`).toBe("SKIP");
      expect(d.notional).toBe(0);
    }
  });

  it("clamps probability and confidence into range instead of trusting them", () => {
    const d = parseDecision({ action: "ENTER", notional: 1, probability: 7, confidence: -3 }, { maxNotional: 5 });
    expect(d.probability).toBe(1);
    expect(d.confidence).toBe(0);
  });

  it("drops a probability that is not a number", () => {
    for (const p of ["0.7", null, {}, NaN]) {
      expect(parseDecision({ action: "SKIP", probability: p }, { maxNotional: 5 }).probability).toBeNull();
    }
  });

  it("never throws, whatever arrives", () => {
    for (const raw of [null, undefined, 42, "ENTER", [], { action: "BUY" }, { action: 1 }]) {
      const d = parseDecision(raw, { maxNotional: 5 });
      expect(d.action).toBe("SKIP");
      expect(d.notional).toBe(0);
      expect(d.reason).toBeTruthy();
    }
  });

  it("truncates a reason rather than storing an essay", () => {
    const d = parseDecision({ action: "SKIP", reason: "x".repeat(5_000) }, { maxNotional: 5 });
    expect(d.reason!.length).toBeLessThanOrEqual(200);
  });

  it("zeroes the size on a SKIP even when one was offered", () => {
    expect(parseDecision({ action: "SKIP", notional: 4 }, { maxNotional: 5 }).notional).toBe(0);
  });
});

describe("asking a remote agent", () => {
  it("returns the decision when the endpoint behaves", async () => {
    const d = await askAgent("https://a.test", ctx(), { fetchImpl: ok({ action: "ENTER", notional: 2, probability: 0.7 }) });
    expect(d.action).toBe("ENTER");
    expect(d.notional).toBe(2);
  });

  it("sends the context as JSON", async () => {
    const seen: { url: unknown; init: RequestInit | undefined }[] = [];
    const f = vi.fn(async (url: unknown, init?: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ action: "SKIP" }), { status: 200 });
    });
    await askAgent("https://a.test", ctx(), { fetchImpl: f as unknown as typeof fetch });
    const body = JSON.parse(seen[0]!.init!.body as string);
    expect(body.market.asset).toBe("BTC");
    expect(body.limits.maxNotional).toBe(5);
  });

  it("skips on a non-2xx rather than throwing", async () => {
    const f = vi.fn(async () => new Response("nope", { status: 500 }));
    const d = await askAgent("https://a.test", ctx(), { fetchImpl: f });
    expect(d.action).toBe("SKIP");
    expect(d.reason).toMatch(/HTTP 500/);
  });

  it("treats a timeout as a decline", async () => {
    const f = vi.fn(async () => {
      throw new DOMException("The operation was aborted", "AbortError");
    });
    const d = await askAgent("https://a.test", ctx(), { fetchImpl: f as unknown as typeof fetch });
    expect(d.action).toBe("SKIP");
    expect(d.reason).toMatch(/did not answer in time/);
  });

  it("treats an unreachable endpoint as a decline", async () => {
    const f = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const d = await askAgent("https://a.test", ctx(), { fetchImpl: f as unknown as typeof fetch });
    expect(d.action).toBe("SKIP");
    expect(d.reason).toMatch(/unreachable/);
  });

  it("skips on a body that is not JSON", async () => {
    const f = vi.fn(async () => new Response("<html>", { status: 200 }));
    expect((await askAgent("https://a.test", ctx(), { fetchImpl: f })).action).toBe("SKIP");
  });

  it("still caps a hostile endpoint at the limit", async () => {
    // The one that matters: an endpoint that has decided to help itself.
    const f = ok({ action: "ENTER", notional: 1e9, probability: 1, confidence: 99 });
    const d = await askAgent("https://a.test", ctx(), { fetchImpl: f });
    expect(d.notional).toBe(5);
    expect(d.confidence).toBe(1);
  });
});

describe("the reference agent", () => {
  const agent = referenceAgent(0.03);

  it("enters when the reference beats the ask by the floor", () => {
    const d = agent(ctx({ price: { bid: 0.6, ask: 0.62, depth: 40 }, reference: { spot: 1, probability: 0.7 } }));
    expect(d.action).toBe("ENTER");
    expect(d.notional).toBeGreaterThan(0);
    expect(d.notional).toBeLessThanOrEqual(5);
  });

  it("skips below the floor, and says by how much", () => {
    const d = agent(ctx({ reference: { spot: 1, probability: 0.63 } }));
    expect(d.action).toBe("SKIP");
    expect(d.reason).toMatch(/below floor/);
  });

  it("skips when there is nothing to price against", () => {
    expect(agent(ctx({ reference: { spot: 1, probability: null } })).action).toBe("SKIP");
    expect(agent(ctx({ price: { bid: null, ask: null, depth: 0 } })).action).toBe("SKIP");
  });

  it("never asks for more than the limit", () => {
    const d = agent(ctx({ reference: { spot: 1, probability: 1 }, price: { bid: 0, ask: 0.01, depth: 99 } }));
    expect(d.notional).toBeLessThanOrEqual(5);
  });

  it("gives the protocol a second implementation", () => {
    // An interface with one implementation is a shape somebody guessed.
    const d = agent(ctx());
    expect(["ENTER", "SKIP"]).toContain(d.action);
    expect(skip("x").action).toBe("SKIP");
  });
});
