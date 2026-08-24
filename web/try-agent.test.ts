// The one unauthenticated endpoint that reaches out, held to that standard.
//
// Everything else Rivo exposes without a sign-in only reads its own database.
// This one takes a URL from a stranger and makes a request to it, which is a
// genuinely different kind of surface — and the reason it exists is that the
// product's central capability was invisible to anybody without an account.
//
// These assert the properties that make it safe to have shipped, by reading the
// route rather than by trusting a memory of it: it verifies before it fetches,
// it never returns the response body, it rate limits per caller, and it says
// HYPOTHETICAL on every answer.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const src = readFileSync(resolve("web/app/api/try-agent/route.ts"), "utf8");
/** Source with comments removed — the rules are about code, not about the notes. */
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the public agent trial", () => {
  it("verifies the URL before it fetches anything", () => {
    // The SSRF verifier must run first. A fetch that happens before the check
    // is a fetch the check cannot prevent.
    const verifyAt = code.indexOf("verifyEndpointUrl");
    const askAt = code.indexOf("askAgent(");
    expect(verifyAt, "no endpoint verification").toBeGreaterThan(-1);
    expect(askAt, "no agent call").toBeGreaterThan(-1);
    expect(verifyAt, "the agent is called before the URL is verified").toBeLessThan(askAt);
    // And a refusal must end the request rather than be logged and ignored.
    expect(code).toMatch(/if \(!check\.ok\)[\s\S]{0,200}status: 400/);
  });

  it("never returns the agent's response body", () => {
    // This is what stops it being a content proxy: a caller must not be able to
    // read a page through Rivo that they could not read themselves. Only the
    // parsed decision fields may cross back.
    expect(code).not.toMatch(/\braw\b|res\.text\(\)|body: *await/);
    const answered = code.slice(code.indexOf("answered:"), code.indexOf("verdict:"));
    for (const field of ["action", "probability", "confidence", "notional", "reason"]) {
      expect(answered, `answered omits ${field}`).toContain(field);
    }
    // Nothing else. A spread would quietly carry whatever the parser gained.
    expect(answered).not.toContain("...");
  });

  it("rate limits per caller, tighter than the authenticated write path", () => {
    expect(code).toContain("take(callerKey(req)");
    const limit = code.match(/TRY_LIMIT: Limit = \{ max: (\d+), windowMs: (\d+)/);
    expect(limit, "no trial limit declared").toBeTruthy();
    expect(Number(limit![1])).toBeLessThan(30); // WRITE_LIMIT.max
    expect(code).toMatch(/status: 429/);
  });

  it("takes the first x-forwarded-for entry, not the last", () => {
    // The last entry is attacker-controlled: prepending values would rotate the
    // rate-limit key at will and make the limit decorative.
    expect(code).toMatch(/split\(","\)\[0\]/);
  });

  it("says HYPOTHETICAL on every answer, and stores nothing", () => {
    expect(code).toContain("HYPOTHETICAL");
    // No database import at all — the strongest form of "stores nothing".
    expect(code).not.toMatch(/@rivo\/db|from "@\/lib\/auth"/);
    // Shadow mode, so no signer is reachable even if the pipeline passes.
    expect(code).toMatch(/mode: "shadow"/);
  });

  it("judges the answer with the same pipeline as real execution", () => {
    // The entire value of the trial. An approximation here would tell a builder
    // their agent passes checks it has not actually passed.
    expect(code).toContain("preExecution(");
    expect(code).toContain("@rivo/runtime/pipeline.js");
  });

  it("refuses when no window has an offer, rather than asking about a dead leg", () => {
    // Asking an agent about a leg with no depth tells the caller nothing about
    // their agent and everything about the venue.
    expect(code).toMatch(/depthAtFair > 0/);
    expect(code).toMatch(/status: 503/);
  });

  it("bounds the one field it echoes from somebody else's response", () => {
    const agent = readFileSync(resolve("src/intel/agent.ts"), "utf8");
    const echo = agent.slice(agent.indexOf("unknown action"));
    expect(echo.slice(0, 200), "the unknown-action echo is unbounded").toContain("slice(0,");
  });
});

describe("the trial is offered before the commitment", () => {
  it("puts Try above Connect on the agents page", () => {
    // The capability was invisible to everybody without an account because the
    // sign-in came first. Ordering is the fix.
    const page = readFileSync(resolve("web/app/agents/page.tsx"), "utf8");
    const tryAt = page.indexOf("<TryAgent");
    const connectAt = page.indexOf("<ConnectAgent");
    expect(tryAt, "no trial on the agents page").toBeGreaterThan(-1);
    expect(tryAt).toBeLessThan(connectAt);
  });
});
