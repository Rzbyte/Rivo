// The interface another agent connects through.
//
// Two rules shape every line below, and both are about what Rivo refuses to do.
//
// RIVO NEVER RUNS YOUR CODE. An agent is an HTTP endpoint. Uploaded code means a
// sandbox, and a sandbox means a class of escape bugs this product has no reason
// to take on to answer a question that a POST answers.
//
// RIVO NEVER TRUSTS THE ANSWER. Everything crossing the wire is treated as a
// claim from a stranger: the shape is validated, the numbers are clamped to the
// limits Rivo set, and an endpoint that is slow, wrong or hostile produces a
// SKIP rather than an exception. An agent decides; Rivo keeps validation, risk,
// the wallet, the ledger, reconciliation and settlement.

import type { Asset } from "../core/config.js";
import type { Leg } from "../engine/book.js";
import { timeoutSignal } from "../core/timeout.js";

/** What the agent is asked about. Everything is as of the moment of asking. */
export interface EventContext {
  market: {
    marketId: string;
    asset: Asset;
    leg: Leg;
    intervalSec: number;
    /** Unix seconds at settlement. */
    expiry: number;
    secondsLeft: number;
  };
  price: {
    bid: number | null;
    ask: number | null;
    /** Shares available at or better than Rivo's own reference. */
    depth: number;
  };
  reference: {
    /** Underlying spot at the last fully closed bar. */
    spot: number | null;
    /** Rivo's own probability for this leg. Supplied, never required. */
    probability: number | null;
  };
  limits: {
    /** The most an agent may ask for, in collateral. Rivo enforces it either way. */
    maxNotional: number;
  };
}

export type AgentAction = "ENTER" | "SKIP";

/** What the agent replies. Every field is checked before it is believed. */
export interface AgentDecision {
  action: AgentAction;
  /** The agent's probability for this leg, 0..1. Optional. */
  probability: number | null;
  /** 0..1. Optional, and never used to size anything on its own. */
  confidence: number | null;
  /** Collateral requested. Clamped to `limits.maxNotional`. */
  notional: number;
  reason: string | null;
}

/** A decision that costs nothing and says why. Used for every failure. */
export const skip = (reason: string): AgentDecision => ({
  action: "SKIP",
  probability: null,
  confidence: null,
  notional: 0,
  reason,
});

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const clamp01 = (v: number | null): number | null => (v === null ? null : Math.min(1, Math.max(0, v)));

/**
 * Turn whatever came back into a decision, or into a SKIP that explains itself.
 *
 * Deliberately total: there is no input this throws on. A remote agent is
 * somebody else's process, and the correct response to it returning nonsense is
 * to decline the trade and record why — not to fail a cycle that eight other
 * portfolios are waiting on.
 */
export function parseDecision(raw: unknown, limits: EventContext["limits"]): AgentDecision {
  if (typeof raw !== "object" || raw === null) return skip("agent did not return an object");
  const o = raw as Record<string, unknown>;

  const action = o.action === "ENTER" ? "ENTER" : o.action === "SKIP" ? "SKIP" : null;
  if (action === null) return skip(`agent returned an unknown action: ${JSON.stringify(o.action)}`);

  const probability = clamp01(num(o.probability));
  const confidence = clamp01(num(o.confidence));
  const reason = typeof o.reason === "string" ? o.reason.slice(0, 200) : null;

  if (action === "SKIP") return { action, probability, confidence, notional: 0, reason };

  // An ENTER has to name a size, and the size has to be Rivo's to cap. An agent
  // asking for more than the limit is not an error — it is an agent asking, and
  // the answer is the limit.
  const asked = num(o.notional);
  if (asked === null || asked <= 0) return skip("agent asked to enter without a positive notional");
  const notional = Math.min(asked, limits.maxNotional);

  return { action, probability, confidence, notional, reason };
}

export interface AskOptions {
  timeoutMs?: number;
  /**
   * Extra headers, for an endpoint that needs a bearer token.
   *
   * Supplied by the caller from server-side storage. The browser never sees
   * one — a secret that reaches the client is a secret that is published.
   */
  headers?: Record<string, string>;
  /** Injected in tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Ask a remote agent about one Event Contract.
 *
 * Never throws. Every failure mode — unreachable, slow, non-2xx, unparseable —
 * becomes a SKIP carrying the reason, which is then recorded in the shadow
 * ledger like any other decision. An agent that times out has declined.
 */
export async function askAgent(endpoint: string, ctx: EventContext, o: AskOptions = {}): Promise<AgentDecision> {
  const f = o.fetchImpl ?? fetch;
  try {
    const res = await f(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...(o.headers ?? {}) },
      body: JSON.stringify(ctx),
      signal: timeoutSignal(o.timeoutMs ?? 4_000),
      // Never follow a redirect.
      //
      // The endpoint was vetted before it was stored — scheme, literal address,
      // and the addresses its hostname resolves to. A 302 discards all of that:
      // a target that resolves publicly and then redirects to 169.254.169.254
      // defeats any amount of pre-flight checking, because the second request is
      // one the checker never saw.
      redirect: "manual",
    });
    if (res.status >= 300 && res.status < 400) return skip("agent redirected, which Rivo does not follow");
    if (!res.ok) return skip(`agent returned HTTP ${res.status}`);
    return parseDecision(await res.json(), ctx.limits);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return skip(/abort|timeout/i.test(m) ? "agent did not answer in time" : `agent unreachable: ${m.slice(0, 120)}`);
  }
}

/**
 * Rivo's own model, wrapped in the same interface.
 *
 * Here so the protocol has two implementations from the first day. An interface
 * with one implementation is a shape somebody guessed; one with two has been
 * asked at least once whether it fits anything but its author.
 *
 * `minEdge` is the same floor the production allocator uses, and this agent is
 * as REJECTED as the strategy it wraps — the gate reads the verdict, not this
 * function.
 */
export function referenceAgent(minEdge = 0.03): (ctx: EventContext) => AgentDecision {
  return (ctx) => {
    const p = ctx.reference.probability;
    const ask = ctx.price.ask;
    if (p === null) return skip("no reference probability for this window");
    if (ask === null) return skip("nothing offered on this leg");
    const edge = p - ask;
    if (edge < minEdge) {
      return { action: "SKIP", probability: p, confidence: null, notional: 0, reason: `edge ${edge >= 0 ? "+" : ""}${edge.toFixed(3)} below floor ${minEdge}` };
    }
    // Deliberately crude: the sizing that matters is Rivo's, and an agent that
    // sized cleverly here would be claiming an authority it does not have.
    return {
      action: "ENTER",
      probability: p,
      confidence: Math.min(1, edge / 0.2),
      notional: Math.min(ctx.limits.maxNotional, ctx.limits.maxNotional * Math.min(1, edge / 0.1)),
      reason: `reference ${p.toFixed(3)} against ask ${ask.toFixed(3)}`,
    };
  };
}
