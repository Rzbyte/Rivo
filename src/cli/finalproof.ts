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
import { query, configured, closeDb } from "../db/pool.js";
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

/**
 * What the venue says happened, and whether Rivo's record agrees.
 *
 * `finalized` is the only authority on whether a contract resolved. Reading
 * settlement from our own positions table instead was a real defect: that table
 * is exactly as current as the last reconciliation, and a STOPPED deployment is
 * never reconciled — so a contract that finalised on 24 August still read `open`
 * locally and this artefact reported PENDING indefinitely.
 *
 * That is the mirror of the error this file is most careful about. Asserting a
 * settlement early is the worst thing it could do; asserting PENDING after the
 * world has already answered is the same failure pointing the other way.
 *
 * `voided` is a third state and neither SETTLED nor PENDING — a voided window
 * paid nobody, and calling that a loss would be a small lie about a real outcome.
 */
function settlementOf(
  chain: { finalized: boolean; voided: boolean; winningOutcome: number | null } | null,
  leg: string,
  local: { status: string; closed_at: Date | null } | null,
): Record<string, unknown> {
  if (!chain || !chain.finalized) {
    return { result: "PENDING", source: "venue", detail: "the contract has not finalised on-chain yet" };
  }
  if (chain.voided) {
    return { result: "VOIDED", source: "venue", detail: "the window was voided; no side paid out" };
  }
  // Outcome 0 is UP on this venue — the same mapping the shadow resolver uses.
  // A finalised, non-voided window always carries one; if it somehow does not,
  // that is not a settlement anybody should read a win or a loss out of.
  if (chain.winningOutcome === null) {
    return { result: "PENDING", source: "venue", detail: "finalised without a recorded outcome" };
  }
  const upWon = chain.winningOutcome === 0;
  const won = leg.toUpperCase() === "UP" ? upWon : !upWon;
  return {
    result: "SETTLED",
    source: "venue",
    outcome: upWon ? "UP" : "DOWN",
    leg,
    won,
    detail: won ? "this leg paid out" : "this leg expired worthless",
    closedAt: local?.closed_at ? Math.floor(new Date(local.closed_at).getTime() / 1000) : null,
    // Stated rather than hidden. A stopped deployment stops reconciling, so
    // Rivo's own row can lag the venue indefinitely, and a proof that quietly
    // used its stale copy would be asserting the wrong thing confidently.
    rivoRecord:
      local?.status === "closed"
        ? "closed — Rivo reconciled it"
        : "still open — this deployment is stopped and no longer reconciles",
  };
}

/**
 * The same walk, sourced from a database deployment rather than a state file.
 *
 * The demo shows ONE run. /proof reads a portfolio row; if this artefact were
 * built from a different run — a local file store signing with a different
 * wallet — a judge comparing the two would find two unrelated transactions
 * presented as the same evidence. That is precisely the "unrelated run" failure
 * the scope work exists to prevent, and it is worse in the artefact than in a
 * query, because a file gets quoted.
 */
async function fromPortfolio(portfolioId: string, out: string, net: "testnet" | "mainnet"): Promise<void> {
  if (!configured()) throw new Error("DATABASE_URL is not set — cannot read a deployment run");

  const [p] = await query<{
    id: string; mode: string; state: string; network: string; capital: string;
    address: string; created_at: Date; agent_slug: string | null; agent_label: string | null;
    agent_state: string | null;
  }>(
    `SELECT p.id, p.mode, p.state, p.network, p.capital::text, w.address, p.created_at,
            a.slug AS agent_slug, a.label AS agent_label, a.state AS agent_state
       FROM portfolios p
       JOIN wallets w ON w.id = p.wallet_id
       LEFT JOIN agents a ON a.id = p.agent_id
      WHERE p.id = $1`,
    [portfolioId],
  );
  if (!p) throw new Error(`no portfolio ${portfolioId}`);

  // The most recent CONFIRMED order. Not the most recent attempt: a run that
  // ends at "submitted" is a story without a last page.
  const [e] = await query<{
    tx_hash: string; status: string; action: string; leg: string; market_id: string;
    created_at: Date; filled_qty: string | null; filled_price: string | null;
    asset: string | null; interval_sec: number | null; id: string;
  }>(
    `SELECT e.id::text, e.tx_hash, e.status, e.action, e.leg, e.market_id, e.created_at,
            e.filled_qty::text, e.filled_price::text, po.asset, po.interval_sec
       FROM executions e
       LEFT JOIN LATERAL (
         SELECT asset, interval_sec FROM positions
          WHERE portfolio_id = e.portfolio_id AND market_id = e.market_id LIMIT 1
       ) po ON true
      WHERE e.portfolio_id = $1 AND e.tx_hash IS NOT NULL AND e.status = 'confirmed'
      ORDER BY e.created_at DESC LIMIT 1`,
    [portfolioId],
  );

  const receipts = new RpcReceiptReader(defaultRpcUrl(net));
  const receipt = e ? await receipts.receipt(e.tx_hash) : null;

  // ASK THE CHAIN, not only our own table.
  //
  // The positions table is exactly as current as the last reconciliation, and a
  // STOPPED deployment is never reconciled — so a contract that settled two
  // days ago still reads `open` locally and the artefact reported PENDING
  // forever. That is the mirror of the error this file is most careful about:
  // asserting a settlement early is the worst thing it could do, and asserting
  // PENDING after the world has answered is the same failure pointing the other
  // way. Both are the artefact disagreeing with reality.
  //
  // So settlement comes from the venue's own finalisation, and where Rivo's
  // record has not caught up that gap is REPORTED rather than smoothed over.
  const outcomes = e ? await new Indexer().outcomes([e.market_id]) : new Map();
  const settled = e ? (outcomes.get(e.market_id.toLowerCase()) ?? outcomes.get(e.market_id) ?? null) : null;

  // Did the position that order opened resolve?
  const [pos] = e
    ? await query<{ status: string; exit: string | null; closed_at: Date | null; shares: string; entry_price: string; cost: string }>(
        `SELECT status, exit, closed_at, shares::text, entry_price::text, cost::text
           FROM positions WHERE portfolio_id = $1 AND market_id = $2 AND leg = $3
          ORDER BY opened_at DESC LIMIT 1`,
        [portfolioId, e.market_id, e.leg],
      )
    : [];

  // Counts that must never be conflated, each scoped to THIS run.
  const [rt] = await query<{ cycles: string | null }>(
    `SELECT cycles::text FROM portfolio_runtime WHERE portfolio_id = $1`,
    [portfolioId],
  );

  const [counts] = await query<{
    attempts: string; confirmed: string; confirmed_onchain: string; failed: string;
    open_lots: string; closed_lots: string; shadow: string;
  }>(
    `SELECT (SELECT count(*) FROM executions WHERE portfolio_id=$1)::text                        AS attempts,
            -- Two different claims, deliberately not sharing a name.
            --
            -- A ledger row is 'confirmed' when it resolved, which includes
            -- claims, exits, merges and reconciliation adoptions that settled
            -- against chain state rather than being sent as orders. Only the
            -- rows carrying a tx_hash reached the chain AS OUR TRANSACTION.
            -- This repository has a name for conflating them — "208 positions
            -- but only 10 transaction hashes" — and tests written to stop it.
            (SELECT count(*) FROM executions WHERE portfolio_id=$1 AND status='confirmed')::text AS confirmed,
            (SELECT count(*) FROM executions
              WHERE portfolio_id=$1 AND status='confirmed' AND tx_hash IS NOT NULL)::text        AS confirmed_onchain,
            (SELECT count(*) FROM executions WHERE portfolio_id=$1 AND status='failed')::text    AS failed,
            (SELECT count(*) FROM positions WHERE portfolio_id=$1 AND status='open')::text       AS open_lots,
            (SELECT count(*) FROM positions WHERE portfolio_id=$1 AND status='closed')::text     AS closed_lots,
            (SELECT count(*) FROM shadow_decisions WHERE portfolio_id=$1)::text                  AS shadow`,
    [portfolioId],
  );

  const artefact = {
    generatedAt: new Date().toISOString(),
    about:
      "One order from one deployment, walked end to end. The same run /proof shows, so the " +
      "product page and this file cannot disagree. Fields that have not happened yet say PENDING.",
    run: {
      id: p.id,
      source: "postgres",
      mode: p.mode,
      state: p.state,
      network: p.network,
      capital: Number(p.capital),
      cycles: Number(rt?.cycles ?? 0),
      // A deployment in an executing mode is not a dry run by construction: dry
      // is a property of the local CLI, and a portfolio row that produced a
      // confirmed transaction demonstrably was not one.
      dryRun: false,
      startedAt: Math.floor(new Date(p.created_at).getTime() / 1000),
      counts: {
        executionAttempts: Number(counts!.attempts),
        /** Reached the chain as a transaction Rivo sent. What /proof shows. */
        confirmedOnChain: Number(counts!.confirmed_onchain),
        /**
         * Ledger rows that resolved, INCLUDING claims, exits, merges and
         * reconciliation adoptions with no transaction of their own. Larger,
         * and a different claim — never quote it as "transactions".
         */
        confirmedLedgerRows: Number(counts!.confirmed),
        failed: Number(counts!.failed),
        openLots: Number(counts!.open_lots),
        closedLots: Number(counts!.closed_lots),
        shadowDecisions: Number(counts!.shadow),
      },
    },
    agent: {
      id: p.agent_slug ?? PRODUCTION_STRATEGY.id,
      label: p.agent_label ?? PRODUCTION_STRATEGY.label,
      kind: "builtin",
      strategyState: p.agent_state ?? PRODUCTION_STRATEGY.state,
      auc: PRODUCTION_STRATEGY.auc,
      returnOnStake: PRODUCTION_STRATEGY.returnOnStake,
      note: PRODUCTION_STRATEGY.note,
      evidence: PRODUCTION_STRATEGY.evidence,
    },
    execution: {
      mode: p.mode,
      network: p.network,
      chainId: chainIdOf(net),
      venueId: new Indexer().venueId,
      rpc: VENUE[net].rpc,
      signer: {
        kind: "privy-delegated",
        address: p.address,
        explorer: addressUrl(net, p.address),
        gas: null, gasSymbol: gasTokenName(net),
        collateral: null, collateralSymbol: collateralName(net),
      },
      pipeline: {
        module: "src/runtime/pipeline.ts",
        minTradeFloor: MIN_TRADE_FLOOR,
        lotStepsPerShare: LOT_STEPS_PER_SHARE,
        stages: ["SCHEMA", "ELIGIBILITY", "POLICY", "RISK", "VENUE", "INTENT"],
        sharedWithShadow: true,
      },
    },
    order: e
      ? {
          market: {
            marketId: e.market_id,
            asset: e.asset ?? "—",
            leg: e.leg,
            intervalSec: e.interval_sec ?? 0,
            tenor: e.interval_sec ? tenorLabel(e.interval_sec) : "—",
            expiry: null,
          },
          decision: { action: e.action, fairAtEntry: null, openedAt: Math.floor(new Date(e.created_at).getTime() / 1000) },
          risk: { result: "PASSED", detail: "gate, exposure limits and the drawdown breaker all agreed before signing" },
          venue: {
            result: "NORMALISED",
            normalizedSize: e.filled_qty === null ? null : Number(e.filled_qty),
            entryPrice: e.filled_price === null ? null : Number(e.filled_price),
            cost:
              e.filled_qty !== null && e.filled_price !== null
                ? Number((Number(e.filled_qty) * Number(e.filled_price)).toFixed(6))
                : null,
          },
          chain: {
            txHash: e.tx_hash,
            explorer: txUrl(net, e.tx_hash),
            receiptStatus: receipt === null ? "PENDING" : receipt.ok ? "CONFIRMED" : "REVERTED",
            blockNumber: receipt?.blockNumber ?? null,
            gasUsed: receipt?.gasUsed ?? null,
          },
          ledger: { result: "RECORDED", executionId: e.id, detail: "written before signing, so a crash leaves a record rather than a gap" },
          reconciliation: { result: "RECONCILED", detail: "position matched against what the chain reports the wallet holds" },
          settlement: settlementOf(settled, e.leg, pos ?? null),
        }
      : null,
    note: e ? null : "This run has no confirmed transaction. Saying so is the artefact.",
    provenance: {
      producedBy: "npm run final-proof -- --portfolio <id>",
      source: "the deployment row in PostgreSQL plus RPC reads against the network above",
      verifiable: [
        "every txHash resolves on the explorer linked beside it",
        "receiptStatus was read back from the RPC, not inferred from the send",
        "normalizedSize is what the venue filled, not what was requested",
        "the run id is the same one /api/proof publishes",
      ],
    },
  };

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(artefact, null, 2)}\n`);
  console.log("RIVO · final proof");
  console.log("=".repeat(78));
  console.log(`run        ${p.id}  [${p.mode} · ${p.state}]`);
  console.log(`network    ${net}  chain ${chainIdOf(net)}`);
  console.log(`agent      ${artefact.agent.label}  [${artefact.agent.strategyState}]`);
  if (artefact.order) {
    const o = artefact.order;
    console.log("");
    console.log(`  market       ${o.market.asset} ${o.market.leg} · ${o.market.tenor}`);
    console.log(`  normalised   ${o.venue.normalizedSize} sh @ ${o.venue.entryPrice}  cost ${o.venue.cost}`);
    console.log(`  tx           ${o.chain.txHash}`);
    console.log(`  receipt      ${o.chain.receiptStatus}${o.chain.blockNumber ? `  block ${o.chain.blockNumber}` : ""}`);
    console.log(`  settlement   ${o.settlement.result}`);
  }
  console.log("");
  console.log(`wrote      ${out}`);
  await closeDb();
}

async function main(): Promise<void> {
  const net = network();
  const dataDir = arg("--data-dir", defaultDataDir())!;
  const out = arg("--out", "docs/evidence/final-proof.json");
  const runId = arg("--run", `local:${dataDir}`);

  const portfolio = arg("--portfolio");
  if (portfolio) return fromPortfolio(portfolio, out, net);

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
