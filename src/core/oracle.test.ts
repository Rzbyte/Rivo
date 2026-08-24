// The link that turns "the venue says UP" into a proof.
//
// A settlement stage that reports only the venue's answer is one link short: it
// does not say who decided, on what schedule, by what agreement, or in which
// transaction. The Prophecy Oracle publishes all four and writes the answer
// on-chain under its own hash — a SECOND transaction, independent of Rivo's,
// that a reader can check without trusting anything here.
//
// These tests are about the mapping and the failure behaviour. The join is on a
// window's exact expiry, and a tolerance would silently attach one window's
// provenance to another's — which is worse than having none.

import { describe, expect, it, vi, afterEach } from "vitest";
import { questionFor } from "./oracle.js";
import { VENUE } from "./venue.js";

const ROW = {
  id: "44395",
  questionText: "What is the price of BTC in USDC at unix time 1787529600 UTC?",
  status: "Resolved",
  resolutionTime: "1787529600",
  resolvedAtTimestamp: "1787529602",
  resolvedTxHash: "0x883cbc87468a93f6efe22a41a0cc8f912ff35fdf6b801db606ddf0dd7d082671",
  resolvedAtBlock: "469567400",
  minAgreement: 4,
  subcommitteeSize: 3,
  subcommitteeThreshold: 2,
  numericDecimals: 2,
  answers: [{ numericValue: "7773000", voided: false }],
};

/** Replace fetch with one that returns `body`, and record what was sent. */
function stub(body: unknown, init: { ok?: boolean } = {}) {
  const calls: { url: string; payload: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", async (url: string, opts: { body: string }) => {
    calls.push({ url, payload: JSON.parse(opts.body) as Record<string, unknown> });
    return { ok: init.ok ?? true, json: async () => body } as Response;
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("the settling question", () => {
  it("scales the answer by the oracle's DECLARED decimals", () => {
    // Not by a guess. scaleReference() has to infer a power of ten because the
    // markets path does not carry this field — see docs/SDK-FEEDBACK.md §1.
    // Here it is declared, so inferring would be reintroducing the bug.
    stub({ data: { Question: [ROW] } });
    return questionFor("testnet", "BTC", 1787529600).then((q) => {
      expect(q).not.toBeNull();
      expect(q!.value).toBe(77_730);
      expect(q!.decimals).toBe(2);
    });
  });

  it("carries the committee and a second on-chain hash", async () => {
    stub({ data: { Question: [ROW] } });
    const q = await questionFor("testnet", "BTC", 1787529600);
    expect(q!.committee).toEqual({ size: 3, threshold: 2, minAgreement: 4 });
    expect(q!.resolvedTxHash).toMatch(/^0x[0-9a-f]{64}$/i);
    // Independent of any transaction Rivo sent.
    expect(q!.resolvedTxHash).not.toBe("0x48cbabda4ad7a9f0f9196949278a0ec5fb09097d16a7a893ce592b66a18e8b91");
  });

  it("matches a window's expiry exactly, never approximately", async () => {
    const calls = stub({ data: { Question: [ROW] } });
    await questionFor("testnet", "BTC", 1787529600);
    const vars = (calls[0]!.payload as { variables: { t: string; asset: string } }).variables;
    expect(vars.t).toBe("1787529600");
    // An `_eq`, not a range. A tolerance would attach one window's provenance
    // to a neighbouring window's, which is a confident wrong answer.
    const query = String((calls[0]!.payload as { query: string }).query);
    expect(query).toContain("_eq");
    expect(query).not.toMatch(/_gte|_lte|_gt|_lt/);
    expect(vars.asset).toBe("%BTC%");
  });

  it("asks the network's own oracle", async () => {
    const calls = stub({ data: { Question: [ROW] } });
    await questionFor("testnet", "BTC", 1787529600);
    expect(calls[0]!.url).toBe(VENUE.testnet.oracle);
    expect(VENUE.testnet.oracle).not.toBe(VENUE.mainnet.oracle);
  });

  it("degrades to null rather than breaking the page that asked", async () => {
    // Provenance is worth having and is not worth an outage. Every failure mode
    // is the same answer: no question, and the proof says so.
    for (const body of [
      { data: { Question: [] } },
      { data: {} },
      {},
      { errors: [{ message: "boom" }] },
    ]) {
      stub(body);
      await expect(questionFor("testnet", "BTC", 1787529600)).resolves.toBeNull();
    }
    stub({ data: { Question: [ROW] } }, { ok: false });
    await expect(questionFor("testnet", "BTC", 1787529600)).resolves.toBeNull();

    vi.stubGlobal("fetch", async () => {
      throw new Error("network is gone");
    });
    await expect(questionFor("testnet", "BTC", 1787529600)).resolves.toBeNull();
  });

  it("reports an unanswered question without inventing a value", async () => {
    stub({
      data: {
        Question: [{ ...ROW, status: "Scheduled", resolvedAtTimestamp: null, resolvedTxHash: null, answers: [] }],
      },
    });
    const q = await questionFor("testnet", "BTC", 1787529600);
    expect(q!.status).toBe("Scheduled");
    expect(q!.value).toBeNull();
    expect(q!.resolvedTxHash).toBeNull();
  });

  it("does not divide by a decimals field that is missing", async () => {
    stub({ data: { Question: [{ ...ROW, numericDecimals: null }] } });
    const q = await questionFor("testnet", "BTC", 1787529600);
    // Null rather than the raw integer. Reporting 7773000 as a BTC price is the
    // exact failure the declared-decimals field exists to prevent.
    expect(q!.value).toBeNull();
  });
});
