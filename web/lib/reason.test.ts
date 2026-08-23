// The fixtures here are not invented. Every one of them is a `binding` that was
// read back out of the live portfolio's decision log, which is the only reason
// they are worth asserting on: a translation table is exactly the kind of code
// that passes its own imagined inputs and then meets production.

import { describe, expect, it } from "vitest";
import { humanise, isFault, shorten } from "./reason.js";

// Verbatim, including the calldata. This is the string that rendered as the
// largest element on the dashboard.
const APPROVE_FAILURE = `approving pool 0x3ae79C8A… failed: An unknown error occurred while executing the contract function "approve".

Request Arguments:
  from:  0x1b4b0195b32053489992649813dc02fc5e282e2e
  to:    0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E
  data:  0x095ea7b3000000000000000000000000003ae79c8a2c3197b57af3715b74ba1e96bce82607ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff

Details: No valid authorization signatures were provided. Your payload may be malformed or your signing keys may be incorrect or expired.
Docs: https://docs.privy.io/api-reference/authorization-signatures
Version: viem@2.55.19`;

describe("humanise", () => {
  it("replaces a chain exception with a sentence, not a shorter exception", () => {
    const out = humanise(APPROVE_FAILURE);
    expect(out).toBe("Rivo was not allowed to sign — reconnect Autopilot");
    // The point of the whole module: none of the machine's vocabulary survives.
    for (const leak of ["0x095ea7b3", "viem", "Docs:", "approve", "Request Arguments"]) {
      expect(out).not.toContain(leak);
    }
  });

  it("names the root cause when a failure carries both", () => {
    // The text matches the approval rule too. A user told "could not get
    // permission" would go looking at their balance; the signature is the thing
    // they can actually fix.
    expect(APPROVE_FAILURE).toMatch(/approving pool/);
    expect(humanise(APPROVE_FAILURE)).toContain("reconnect Autopilot");
  });

  it("leaves a deliberate refusal exactly as the engine wrote it", () => {
    const refusals = [
      "edge -0.015 below floor",
      "inside expiry headroom (280s left)",
      "top-up of 0.32 below minimum trade 0.50 — not worth the spread",
      "would add 1.58 to BTC delta budget, 6.00 cap already 26% used",
    ];
    for (const r of refusals) {
      expect(humanise(r)).toBe(r);
      expect(isFault(r)).toBe(false);
    }
  });

  it("translates the other faults seen in the ledger", () => {
    expect(humanise("@somnia-chain/markets-sdk: placeBinaryOrder reverted: for an unknown reason. — while placing sell YES 1.86 @ 0.01")).toBe(
      "The venue turned this order down",
    );
    expect(humanise("Missing 'privy-authorization-signature' header")).toContain("reconnect Autopilot");
    expect(humanise("insufficient funds for gas * price + value")).toContain("network fee");
  });

  it("marks faults apart from refusals", () => {
    expect(isFault(APPROVE_FAILURE)).toBe(true);
    expect(isFault("edge -0.015 below floor")).toBe(false);
  });
});

describe("shorten", () => {
  it("prefers a sentence boundary to a hard cut", () => {
    expect(shorten("The first sentence is comfortably long enough to keep. The second is not.", 60)).toBe(
      "The first sentence is comfortably long enough to keep.",
    );
  });

  it("collapses the newlines that make a card grow", () => {
    expect(shorten("one\n\n  two   three")).toBe("one two three");
  });

  it("does not pad or cut a phrase that already fits", () => {
    expect(shorten("edge -0.015 below floor")).toBe("edge -0.015 below floor");
  });

  it("still cuts a single unbroken sentence", () => {
    expect(shorten("x".repeat(400))).toHaveLength(151);
  });
});
