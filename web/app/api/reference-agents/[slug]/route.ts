// The six baseline strategies, published as endpoints somebody else could have written.
//
// They are hosted here, and they are still registered as `kind: 'http'` with
// their public URL rather than as `builtin`. That costs a network round trip
// per decision and it buys the thing the study needs: every baseline travels
// the IDENTICAL path a stranger's agent travels — SSRF vetting in
// `src/intel/endpoint.ts`, a 4s timeout, redirects refused, the response shape
// validated and every number clamped in `parseDecision`, then `preExecution()`.
//
// A builtin shortcut would have been simpler and would have proved less: a
// study whose subjects get privileged access is measuring its own plumbing. It
// also means these six are a working, runnable reference implementation of the
// agent contract — the thing a builder can copy.
//
// GET returns the contract and the rule, so the URL is readable in a browser.
// POST is the agent protocol.

import { NextResponse } from "next/server";
import { BASELINES, baselineBySlug } from "@rivo/intel/baselines.js";
import { skip, type EventContext } from "@rivo/intel/agent.js";

export const dynamic = "force-dynamic";

/**
 * Trust nothing about the body, including that it is the shape we published.
 *
 * Rivo is the caller here today, but the URL is public and unauthenticated —
 * it has to be, or it would not be reachable by the same vetting path a
 * stranger's endpoint gets. So this coerces rather than asserts, and a missing
 * field becomes a null the baselines already know how to decline on.
 */
function readContext(raw: unknown): EventContext | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const m = (o.market ?? {}) as Record<string, unknown>;
  const p = (o.price ?? {}) as Record<string, unknown>;
  const r = (o.reference ?? {}) as Record<string, unknown>;
  const l = (o.limits ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const leg = m.leg === "DOWN" ? "DOWN" : "UP";

  const intervalSec = num(m.intervalSec);
  const secondsLeft = num(m.secondsLeft);
  const maxNotional = num(l.maxNotional);
  // Without these three no baseline can size or phase anything, and inventing
  // defaults would silently turn "the caller sent nothing" into a trade.
  if (intervalSec === null || intervalSec <= 0 || secondsLeft === null || maxNotional === null) return null;

  return {
    market: {
      marketId: typeof m.marketId === "string" ? m.marketId : "",
      asset: m.asset === "ETH" ? "ETH" : "BTC",
      leg,
      intervalSec,
      expiry: num(m.expiry) ?? 0,
      secondsLeft,
    },
    price: { bid: num(p.bid), ask: num(p.ask), depth: num(p.depth) ?? 0 },
    reference: { spot: num(r.spot), probability: num(r.probability) },
    limits: { maxNotional: Math.max(0, maxNotional) },
  };
}

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await ctx.params;
  const baseline = baselineBySlug(slug);
  if (!baseline) {
    return NextResponse.json(
      { error: `no such baseline: ${slug}`, available: BASELINES.map((b) => b.slug) },
      { status: 404 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    // A SKIP rather than a 400. The agent contract says a decision is always
    // returned and the reason is always recorded, and answering the malformed
    // case with an error code would make these six the one kind of agent whose
    // failures do not appear in the shadow ledger.
    return NextResponse.json(skip("body was not JSON"));
  }

  const event = readContext(body);
  if (!event) return NextResponse.json(skip("body was not an EventContext"));

  return NextResponse.json(baseline.decide(event));
}

/** Readable in a browser, so the endpoint documents itself. */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await ctx.params;
  const baseline = baselineBySlug(slug);
  if (!baseline) {
    return NextResponse.json(
      { error: `no such baseline: ${slug}`, available: BASELINES.map((b) => b.slug) },
      { status: 404 },
    );
  }
  return NextResponse.json({
    slug: baseline.slug,
    label: baseline.label,
    question: baseline.question,
    method: "POST",
    about:
      "A baseline strategy in Rivo's breadth study. Rivo POSTs one Event Contract as an " +
      "EventContext and this answers with an AgentDecision. It is not advice and it has no " +
      "signer: nothing here can send a transaction.",
    source: "src/intel/baselines.ts",
  });
}
