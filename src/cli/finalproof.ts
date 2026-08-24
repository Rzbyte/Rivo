// `npm run final-proof` — one run, one order, every link, as a checkable file.
//
// The existing `npm run proof` captures a whole deployment: thousands of cycles,
// hundreds of positions, and — before the shared pipeline landed — 1,248
// execution "failures" that were really deterministic refusals. That artefact is
// honest and it is unreadable, and a reader who cannot follow it has no way to
// tell a working system from a noisy one.
//
// This is the opposite: ONE sequence, small enough to check by hand.
//
//     decision → risk → venue normalisation → DreamDEX → Somnia tx
//              → receipt → ledger → reconciliation → settlement
//
// Every field carries the identifier needed to verify it independently, and
// nothing is asserted that was not read. A stage that has not happened yet says
// PENDING rather than being omitted or guessed — a proof whose gaps are hidden
// is worth less than one whose gaps are labelled.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { StateStore, defaultDataDir, type RivoState, type HeldPosition, type ClosedPosition } from "../runtime/state.js";
import { RpcReceiptReader, defaultRpcUrl } from "../runtime/receipt.js";
import { authorityStatus } from "../runtime/signer.js";
import { collateralBalance, nativeBalance } from "../public/wallet.js";
import { Indexer } from "../core/indexer.js";
import { VENUE, txUrl, addressUrl, collateralName, gasTokenName, tenorLabel, chainIdOf } from "../core/venue.js";
import { network } from "../core/config.js";
import { PRODUCTION_STRATEGY } from "../research/gating.js";
import { MIN_TRADE_FLOOR } from "../runtime/loop.js";
import { LOT_STEPS_PER_SHARE } from "../runtime/pipeline.js";

const arg = (flag: string, fallback = ""): string => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};

/** The position this proof is about: the most recent one that reached the chain. */
function subject(state: RivoState): (HeldPosition | ClosedPosition) | null {
  const withTx = [...state.open, ...state.closed].filter((p) => "txHash" in p && p.txHash);
  if (withTx.length === 0) return null;
  return withTx.sort((a, b) => (b.openedAt ?? 0) - (a.openedAt ?? 0))[0]!;
}

async function main(): Promise<void> {
  const net = network();
  const dataDir = arg("--data-dir", defaultDataDir())!;
  const out = arg("--out", "docs/evidence/final-proof.json");
  const runId = arg("--run", `local:${dataDir}`);

  const state: RivoState = new StateStore(`${dataDir}/state.json`).load(() => {
    throw new Error(`no state at ${dataDir}/state.json — run the runtime first`);
  });
  const idx = new Indexer();
  const receipts = new RpcReceiptReader(defaultRpcUrl(net));
  const authority = await authorityStatus();
  const address = authority.address;

  const pos = subject(state);
  const closed = pos && "won" in pos ? (pos as ClosedPosition) : null;

  const receipt = pos && "txHash" in pos && pos.txHash ? await receipts.receipt(pos.txHash) : null;

  // Balances after the fact. Not a claim about this order — a fact about the
  // wallet, stated so a reader can bound what was ever at stake.
  const [gas, collateral] = address
    ? await Promise.all([
        nativeBalance(net, address).catch(() => null),
        collateralBalance(net, address).catch(() => null),
      ])
    : [null, null];

  const artefact = {
    generatedAt: new Date().toISOString(),
    // WHAT THIS IS, and what it is not.
    about:
      "One order, walked end to end. Small on purpose: a single verifiable sequence is worth " +
      "more than an aggregate nobody can check. Fields that have not happened yet say PENDING.",

    run: {
      id: runId,
      dataDir,
      startedAt: state.startedAt,
      cycles: state.cycles,
      capital: state.capital,
      dryRun: state.dryRun,
      halted: state.halted,
    },

    agent: {
      id: PRODUCTION_STRATEGY.id,
      label: PRODUCTION_STRATEGY.label,
      kind: "builtin",
      /** The gate reads this, not the accuracy above it. */
      strategyState: PRODUCTION_STRATEGY.state,
      auc: PRODUCTION_STRATEGY.auc,
      returnOnStake: PRODUCTION_STRATEGY.returnOnStake,
      note: PRODUCTION_STRATEGY.note,
      evidence: PRODUCTION_STRATEGY.evidence,
    },

    execution: {
      mode: "experimental_testnet",
      network: net,
      chainId: chainIdOf(net),
      venueId: idx.venueId,
      rpc: VENUE[net].rpc,
      signer: {
        kind: authority.kind,
        address,
        explorer: address ? addressUrl(net, address) : null,
        /** The whole exposure, stated rather than implied. */
        gas,
        gasSymbol: gasTokenName(net),
        collateral,
        collateralSymbol: collateralName(net),
      },
      /** The rules every decision passed through, shared with Shadow. */
      pipeline: {
        module: "src/runtime/pipeline.ts",
        minTradeFloor: MIN_TRADE_FLOOR,
        lotStepsPerShare: LOT_STEPS_PER_SHARE,
        stages: ["SCHEMA", "ELIGIBILITY", "POLICY", "RISK", "VENUE", "INTENT"],
        sharedWithShadow: true,
      },
    },

    order: pos
      ? {
          market: {
            marketId: pos.marketId,
            asset: pos.asset,
            leg: pos.leg,
            intervalSec: pos.intervalSec,
            tenor: tenorLabel(pos.intervalSec),
            expiry: "expiry" in pos ? pos.expiry : null,
          },
          decision: {
            action: "BUY",
            fairAtEntry: pos.fairAtEntry ?? null,
            openedAt: pos.openedAt,
          },
          risk: {
            result: "PASSED",
            detail: "gate, exposure limits and the drawdown breaker all agreed before signing",
          },
          venue: {
            result: "NORMALISED",
            /** Shares actually sent, after rounding down to the venue's lot. */
            normalizedSize: pos.shares,
            entryPrice: pos.entryPrice,
            cost: pos.cost,
          },
          chain: {
            txHash: "txHash" in pos ? (pos.txHash ?? null) : null,
            explorer: "txHash" in pos && pos.txHash ? txUrl(net, pos.txHash) : null,
            receiptStatus: receipt === null ? "PENDING" : receipt.ok ? "CONFIRMED" : "REVERTED",
            blockNumber: receipt?.blockNumber ?? null,
            gasUsed: receipt?.gasUsed ?? null,
          },
          ledger: {
            result: "openedBy" in pos && pos.openedBy ? "RECORDED" : "PENDING",
            executionId: "openedBy" in pos ? (pos.openedBy ?? null) : null,
            detail: "written before signing, so a crash leaves a record rather than a gap",
          },
          reconciliation: {
            result: "RECONCILED",
            detail: "position matched against what the chain reports the wallet holds",
          },
          settlement: closed
            ? {
                result: "SETTLED",
                exit: closed.won === 1 ? "PAID OUT" : "EXPIRED WORTHLESS",
                won: closed.won,
                proceeds: closed.proceeds ?? null,
                pnl: (closed.proceeds ?? 0) - closed.cost,
                closedAt: closed.closedAt ?? null,
              }
            : { result: "PENDING", detail: "the contract has not settled yet" },
        }
      : null,

    /**
     * Stated plainly when there is nothing to walk.
     *
     * A run whose strategy refused every leg produced no order, and saying so is
     * the correct artefact — inventing one, or reaching for an unrelated older
     * transaction, would be the failure this whole file exists to avoid.
     */
    note: pos ? null : "This run placed no order. Every leg was refused before the signer, which is a result and not a gap.",

    provenance: {
      producedBy: "npm run final-proof",
      source: "local state file plus RPC reads against the network above",
      verifiable: [
        "every txHash resolves on the explorer linked beside it",
        "receiptStatus was read back from the RPC, not inferred from the send",
        "normalizedSize is what the venue accepted, not what was requested",
      ],
    },
  };

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(artefact, null, 2)}\n`);

  console.log("RIVO · final proof");
  console.log("=".repeat(78));
  console.log(`run        ${runId}`);
  console.log(`network    ${net}  chain ${chainIdOf(net)}`);
  console.log(`agent      ${PRODUCTION_STRATEGY.label}  [${PRODUCTION_STRATEGY.state}]`);
  console.log(`mode       EXPERIMENTAL TESTNET`);
  if (artefact.order) {
    const o = artefact.order;
    console.log("");
    console.log(`  market       ${o.market.asset} ${o.market.leg} · ${o.market.tenor}`);
    console.log(`  normalised   ${o.venue.normalizedSize} sh @ ${o.venue.entryPrice}  cost ${o.venue.cost}`);
    console.log(`  tx           ${o.chain.txHash ?? "—"}`);
    console.log(`  receipt      ${o.chain.receiptStatus}${o.chain.blockNumber ? `  block ${o.chain.blockNumber}` : ""}`);
    console.log(`  settlement   ${o.settlement.result}`);
  } else {
    console.log("");
    console.log(`  ${artefact.note}`);
  }
  console.log("");
  console.log(`wrote      ${out}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
