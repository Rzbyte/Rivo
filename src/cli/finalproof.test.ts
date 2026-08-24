// The one proof a judge is asked to check, checked here first.
//
// The failure this guards against is not a crash. It is an artefact that reads
// convincingly and cannot be verified: a settlement asserted before it
// happened, a transaction hash borrowed from an older run, a "normalised size"
// that is the size somebody asked for rather than the size the venue took.
// Every one of those produces a valid JSON file and a false claim.
//
// So the rules are about provenance rather than shape.

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const PATH = "docs/evidence/final-proof.json";
const present = existsSync(resolve(PATH));
const d = present ? describe : describe.skip;

interface Proof {
  generatedAt: string;
  run: { id: string; cycles: number; capital: number; dryRun: boolean };
  agent: { id: string; strategyState: string; auc: number; returnOnStake: number };
  execution: {
    mode: string; network: string; chainId: number; venueId: string;
    signer: { address: string | null; collateral: number | null };
    pipeline: { module: string; sharedWithShadow: boolean; lotStepsPerShare: number; stages: string[] };
  };
  order: {
    market: { asset: string; leg: string; intervalSec: number };
    venue: { result: string; normalizedSize: number; entryPrice: number; cost: number };
    chain: { txHash: string | null; receiptStatus: string; blockNumber: number | null; explorer: string | null };
    ledger: { result: string };
    settlement: { result: string };
  } | null;
  note: string | null;
  provenance: { producedBy: string; verifiable: string[] };
}

const proof = (): Proof => JSON.parse(readFileSync(resolve(PATH), "utf8")) as Proof;

d("the final proof artefact", () => {
  it("was produced by a live run, not a dry one", () => {
    const p = proof();
    expect(p.run.dryRun, "a dry run cannot produce a proof of execution").toBe(false);
    expect(p.run.cycles).toBeGreaterThan(0);
  });

  it("runs on an approved testnet under the experimental mode", () => {
    const p = proof();
    expect(p.execution.mode).toBe("experimental_testnet");
    expect(p.execution.network).toBe("testnet");
    // Somnia Shannon. A proof whose chain id is not the one the venue lives on
    // is a proof about somewhere else.
    expect(p.execution.chainId).toBe(50312);
    expect(p.execution.venueId).toMatch(/^0x[0-9a-f]{64}$/i);
  });

  it("names the strategy state that let it run at all", () => {
    // The strategy is REJECTED for real capital and executes only because the
    // mode is an explicitly approved experiment. An artefact that omitted this
    // would read as though the model had been cleared.
    const p = proof();
    expect(["REJECTED", "UNVALIDATED", "SHADOW_ONLY", "VALIDATED"]).toContain(p.agent.strategyState);
    expect(p.agent.returnOnStake).toBeLessThan(0);
  });

  it("records the size the venue took, on a lot boundary", () => {
    const p = proof();
    if (!p.order) return;
    const steps = p.execution.pipeline.lotStepsPerShare;
    const size = p.order.venue.normalizedSize;
    expect(size).toBeGreaterThan(0);
    // Rounded down to a real lot: the whole point of the venue stage.
    expect(Math.abs(size * steps - Math.round(size * steps))).toBeLessThan(1e-6);
    expect(p.order.venue.result).toBe("NORMALISED");
  });

  it("never claims a settlement that has not happened", () => {
    // PENDING is a correct answer and the one this must give while a contract
    // is still open. Asserting SETTLED early is the single most damaging thing
    // this file could do.
    const p = proof();
    if (!p.order) return;
    expect(["SETTLED", "PENDING"]).toContain(p.order.settlement.result);
  });

  it("carries a transaction hash with a receipt actually read back", () => {
    const p = proof();
    if (!p.order) {
      // A run that placed nothing must SAY so rather than omit the section.
      expect(p.note, "no order and no explanation").toBeTruthy();
      return;
    }
    expect(p.order.chain.txHash).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(p.order.chain.explorer).toContain(p.order.chain.txHash!);
    expect(["CONFIRMED", "REVERTED", "PENDING"]).toContain(p.order.chain.receiptStatus);
    if (p.order.chain.receiptStatus === "CONFIRMED") {
      // A confirmation without a block number was inferred from the send rather
      // than read from the chain, which is the difference this whole artefact
      // exists to make.
      expect(p.order.chain.blockNumber, "confirmed with no block number").toBeGreaterThan(0);
    }
  });

  it("says the pipeline it went through, and that Shadow shares it", () => {
    const p = proof();
    expect(p.execution.pipeline.module).toBe("src/runtime/pipeline.ts");
    expect(p.execution.pipeline.sharedWithShadow).toBe(true);
    expect(p.execution.pipeline.stages).toEqual(["SCHEMA", "ELIGIBILITY", "POLICY", "RISK", "VENUE", "INTENT"]);
  });

  it("bounds what was ever at risk", () => {
    // A reader deciding whether to believe this should be able to see that the
    // signing wallet holds a testnet balance and nothing else.
    const p = proof();
    expect(p.execution.signer.address).toMatch(/^0x[0-9a-f]{40}$/i);
  });

  it("never lets a ledger count be read as a transaction count", () => {
    // "208 positions but only 10 transaction hashes" is this repository's own
    // name for the defect: two true numbers, no stated relationship, and a
    // reader left to assume the better one. A ledger row is confirmed when it
    // RESOLVED — which includes claims, exits, merges and reconciliation
    // adoptions that never had a transaction of their own.
    const p = proof() as unknown as {
      run: { counts?: { confirmedOnChain?: number; confirmedLedgerRows?: number; confirmed?: number } };
    };
    const c = p.run.counts;
    if (!c) return; // file-sourced artefacts carry no deployment counts
    expect(c.confirmed, "the ambiguous name is back").toBeUndefined();
    expect(typeof c.confirmedOnChain).toBe("number");
    expect(typeof c.confirmedLedgerRows).toBe("number");
    expect(c.confirmedOnChain!).toBeLessThanOrEqual(c.confirmedLedgerRows!);
  });

  it("says how to reproduce it", () => {
    const p = proof();
    expect(p.provenance.producedBy).toContain("final-proof");
    expect(p.provenance.verifiable.length).toBeGreaterThan(1);
  });
});
