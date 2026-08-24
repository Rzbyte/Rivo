// Try an agent against a live DreamDEX contract, with no account.
//
// The product's central capability was behind a sign-in. A reader could see the
// contract Rivo speaks, watch it reject its own model, and check a real
// transaction — and could not paste a URL and watch any of it happen. The thing
// most worth trying was the one thing nobody could try.
//
// So this runs ONE decision against ONE live market and returns what happened:
// what Rivo asked, what the endpoint answered, and what the shared
// pre-execution pipeline did with the answer. It stores nothing, registers
// nothing and signs nothing.
//
// SECURITY. This is unauthenticated and it makes an outbound HTTP request to a
// host the caller names, which is a real surface and treated as one:
//
//   * The URL goes through the same verifier the registered path uses —
//     private, loopback, link-local and metadata ranges refused, the hostname
//     resolved and the RESOLVED address checked, so a name that answers
//     publicly and resolves internally does not get through.
//   * Redirects are refused rather than followed, so a public URL cannot bounce
//     the request somewhere private.
//   * Four-second timeout, one request, no retry.
//   * THE RESPONSE BODY IS NEVER RETURNED. Only the typed decision fields come
//     back — action, probability, confidence, notional, and a reason truncated
//     to 200 characters. That is what stops this being a content proxy: a
//     caller cannot use Rivo to read a page they could not read themselves.
//   * Rate limited per address, tighter than the authenticated write path.
//
// What remains is that somebody can learn whether a PUBLIC host answers. That
// is smaller than what any HTTP client already gives them, and it is the cost
// of the feature existing at all.

import { NextResponse } from "next/server";
import { jsonBody } from "@/lib/validate";
import { take, type Limit } from "@/lib/ratelimit";
import { verifyEndpointUrl } from "@rivo/intel/endpoint.js";
import { askAgent, type EventContext } from "@rivo/intel/agent.js";
import { preExecution } from "@rivo/runtime/pipeline.js";
import { snapshot } from "@rivo/engine/scan.js";
import { Indexer } from "@rivo/core/indexer.js";
import { PRODUCTION_STRATEGY } from "@rivo/research/gating.js";
import type { Leg } from "@rivo/engine/book.js";

export const dynamic = "force-dynamic";

/**
 * Tighter than the write path, because this one costs an outbound request.
 *
 * Six a minute is more than a person clicking a button needs and far less than
 * a loop wants.
 */
const TRY_LIMIT: Limit = { max: 6, windowMs: 60_000 };

/** Collateral a trial decision may ask for. Hypothetical either way. */
const MAX_NOTIONAL = 5;

/**
 * Who is calling, for rate limiting.
 *
 * `x-forwarded-for` is a client-settable header everywhere except behind a
 * proxy that overwrites it, which Vercel does. The FIRST entry is the client;
 * taking the last would let a caller prepend their own values and rotate the
 * key at will.
 */
function callerKey(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for") ?? "";
  const first = fwd.split(",")[0]?.trim();
  return `try:${first || req.headers.get("x-real-ip") || "unknown"}`;
}

export async function POST(req: Request): Promise<Response> {
  const verdict = take(callerKey(req), TRY_LIMIT);
  if (!verdict.ok) {
    return NextResponse.json(
      { error: `Too many trials. Try again in ${verdict.retryAfter}s.` },
      { status: 429, headers: { "retry-after": String(verdict.retryAfter) } },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await jsonBody(req);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "bad request" }, { status: 400 });
  }

  const endpoint = typeof body.endpoint === "string" ? body.endpoint.trim() : "";
  if (!endpoint) {
    return NextResponse.json({ error: "Give an endpoint: { \"endpoint\": \"https://…\" }" }, { status: 400 });
  }

  // The same check the registered path runs. Its refusals are written for a
  // builder rather than for a log, so they are safe and useful to pass through.
  const check = await verifyEndpointUrl(endpoint);
  if (!check.ok) {
    return NextResponse.json({ error: check.reason ?? "That endpoint was refused." }, { status: 400 });
  }

  // A live leg worth asking about: the deepest book among windows that are
  // actually tradeable. Asking an agent about a leg with no offer would tell the
  // caller nothing about their agent and everything about the venue.
  let snap;
  try {
    snap = await snapshot(new Indexer());
  } catch {
    return NextResponse.json({ error: "The venue did not answer just now. Try again in a moment." }, { status: 503 });
  }
  const candidates = snap.opportunities.filter((o) => o.ask !== null && o.ask > 0 && o.ask < 1 && o.depthAtFair > 0);
  const pick = candidates.sort((a, b) => b.depthAtFair - a.depthAtFair)[0];
  if (!pick) {
    return NextResponse.json(
      { error: "No DreamDEX window has an offer on the book right now. That is a fact about the venue, not about your agent." },
      { status: 503 },
    );
  }

  const context: EventContext = {
    market: {
      marketId: pick.marketId,
      asset: pick.asset,
      leg: pick.leg as Leg,
      intervalSec: pick.intervalSec,
      expiry: pick.expiry,
      secondsLeft: Math.max(0, pick.expiry - snap.at),
    },
    price: { bid: pick.bid, ask: pick.ask, depth: pick.depthAtFair },
    reference: {
      spot: snap.assets.get(pick.asset)?.spot ?? null,
      probability: Number.isFinite(pick.fair) ? pick.fair : null,
    },
    limits: { maxNotional: MAX_NOTIONAL },
  };

  // Never throws — a timeout, a bad status or an unparseable body all come back
  // as a SKIP carrying the reason.
  const decision = await askAgent(endpoint, context);

  // The same function the real path and Shadow both run. This is the point of
  // the whole exercise: the caller sees their agent judged by the rules that
  // would actually apply, not by a demo approximation.
  const intent = preExecution({
    decision: {
      action: decision.action === "ENTER" ? "BUY" : "SKIP",
      notional: decision.notional,
      price: pick.ask,
    },
    market: { expiry: pick.expiry, now: snap.at, ask: pick.ask },
    policy: {
      mode: "shadow",
      strategyState: PRODUCTION_STRATEGY.state,
      minTrade: 0.25,
      maxNotional: MAX_NOTIONAL,
    },
  });

  return NextResponse.json({
    /** Exactly what was POSTed, so a builder can reproduce the call themselves. */
    asked: context,
    /**
     * What came back, parsed. The raw body is deliberately absent — see the
     * note at the top of this file.
     */
    answered: {
      action: decision.action,
      probability: decision.probability,
      confidence: decision.confidence,
      notional: decision.notional,
      reason: decision.reason,
    },
    /** What Rivo would have done with it, and which stage decided. */
    verdict: {
      outcome: intent.outcome,
      stage: intent.stage,
      code: intent.code,
      reason: intent.reason,
      normalizedSize: intent.shares,
      cost: intent.cost,
    },
    /**
     * Said out loud on every response. A trial runs in shadow, so no signer is
     * reachable from this path in any case — but the sentence costs nothing and
     * removes the only dangerous ambiguity here.
     */
    execution: "HYPOTHETICAL — no transaction was sent, and nothing was stored.",
    limits: { maxNotional: MAX_NOTIONAL, triesPerMinute: TRY_LIMIT.max },
  });
}
