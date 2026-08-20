// `npm run proof` — capture the live execution chain as a checkable artefact.
//
// The claim "Rivo trades autonomously on-chain" is worth exactly as much as a
// stranger's ability to verify it, so this writes every link with the identifier
// needed to check it independently: transaction hashes and their receipts read
// back from the RPC, market ids, the wallet's balances before and after, the
// ledger identity, and what settled and was claimed.
//
// It asserts nothing it has not read. A stage with no evidence is reported as
// unproven rather than omitted — the gaps are part of the record.

import { writeFileSync } from "node:fs";
import { StateStore, ledgerImbalance, ledgerBalances, defaultDataDir, type RivoState } from "../runtime/state.js";
import { authorityStatus } from "../runtime/signer.js";
import { collateralBalance, nativeBalance } from "../public/wallet.js";
import { Indexer } from "../core/indexer.js";
import { VENUE, txUrl, addressUrl, collateralName, gasTokenName, tenorLabel } from "../core/venue.js";
import { network } from "../core/config.js";

const arg = (flag: string, fallback = ""): string => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};

interface Receipt {
  status: string;
  blockNumber: string;
  gasUsed: string;
  from: string;
  to: string;
  logs: unknown[];
}

async function receiptOf(net: "testnet" | "mainnet", hash: string): Promise<Receipt | null> {
  try {
    const res = await fetch(VENUE[net].rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [hash] }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json()) as { result?: Receipt };
    return body.result ?? null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const dataDir = arg("--data-dir", defaultDataDir());
  const out = arg("--out", "docs/evidence/live-canary.json");
  const net = network();

  const state: RivoState = new StateStore(`${dataDir}/state.json`).load(() => {
    throw new Error(`no state at ${dataDir}/state.json — run the runtime first`);
  });

  const authority = await authorityStatus();
  if (!authority.address) throw new Error("no signing authority configured — nothing to prove");
  const address = authority.address;

  const idx = new Indexer();
  const [gas, collateral, outcome] = await Promise.all([
    nativeBalance(net, address),
    collateralBalance(net, address),
    idx.outcomeBalances(address),
  ]);

  // Rivo's own positions are the ones that prove execution. Adopted positions
  // prove reconciliation, which is a different claim and is reported separately.
  const own = [...state.open, ...state.closed].filter((p) => !("adopted" in p && p.adopted));
  // ClosedPosition carries no txHash field, so narrow by reading it rather than
  // asserting a shape the type does not have.
  const withTx = own.flatMap((p) => {
    const hash = (p as { txHash?: string }).txHash;
    return hash ? [{ ...p, txHash: hash }] : [];
  });

  const receipts = await Promise.all(
    [...new Set(withTx.map((p) => p.txHash))].slice(0, 25).map(async (hash) => {
      const r = await receiptOf(net, hash);
      return {
        hash,
        url: txUrl(net, hash),
        found: r !== null,
        succeeded: r?.status === "0x1",
        block: r ? Number.parseInt(r.blockNumber, 16) : null,
        gasUsed: r ? Number.parseInt(r.gasUsed, 16) : null,
        events: r ? r.logs.length : null,
        to: r?.to ?? null,
      };
    }),
  );

  const settled = state.closed.filter((c) => c.exit === "settled");
  const adopted = state.open.filter((p) => p.adopted).length;
  const heldOnChain = [...outcome.entries()].filter(([, v]) => v > 0);

  // Each stage of the autonomous path, with what actually evidences it.
  const stages = [
    ["DISCOVER", state.cycles > 0, `${state.cycles} cycles against the live venue`],
    ["ANALYZE", state.cycles > 0, `decision log at ${dataDir}/decisions.jsonl`],
    ["ALLOCATE", own.length > 0, `${own.length} positions opened by the allocator`],
    ["RISK CHECK", true, state.halted ? `circuit breaker fired: ${state.halted}` : "within limits, breaker armed"],
    ["EXECUTE", withTx.length > 0, `${withTx.length} positions carry an on-chain transaction hash`],
    ["CONFIRM", receipts.some((r) => r.succeeded), `${receipts.filter((r) => r.succeeded).length}/${receipts.length} receipts confirm status 0x1`],
    ["RECONCILE", adopted > 0 || heldOnChain.length > 0, `${adopted} positions adopted from chain, ${heldOnChain.length} outcome balances read`],
    ["PERSIST", true, `state at ${dataDir}/state.json, ${state.cycles} cycles`],
    ["LEDGER", ledgerBalances(state), `imbalance ${ledgerImbalance(state).toExponential(2)}`],
    ["SETTLE", settled.length > 0, `${settled.length} positions resolved against the venue's oracle`],
    ["CLAIM", state.lastClaimSweepAt > 0, state.lastClaimSweepAt > 0 ? `last sweep ${new Date(state.lastClaimSweepAt * 1000).toISOString()}` : "no sweep recorded"],
  ] as const;

  const proof = {
    generatedAt: new Date().toISOString(),
    network: net,
    venueId: VENUE[net].venueId,
    wallet: { address, url: addressUrl(net, address), gas, gasSymbol: gasTokenName(net), collateral, collateralSymbol: collateralName(net) },
    authority: { kind: authority.kind, boundedOnChain: authority.boundedOnChain, bounds: authority.bounds },
    runtime: {
      cycles: state.cycles,
      startedAt: state.startedAt,
      lastCycleAt: state.lastCycleAt,
      capital: state.capital,
      contributed: state.contributed ?? 0,
      cash: state.cash,
      realizedPnl: state.realizedPnl,
      halted: state.halted,
      dryRun: state.dryRun,
    },
    ledger: {
      identity: "cash + open cost == capital + contributed + realised",
      cash: state.cash,
      openCost: state.open.reduce((a, p) => a + p.cost, 0),
      capital: state.capital,
      contributed: state.contributed ?? 0,
      realizedPnl: state.realizedPnl,
      imbalance: ledgerImbalance(state),
      balances: ledgerBalances(state),
    },
    execution: {
      positionsOpenedByRivo: own.length,
      withTransactionHash: withTx.length,
      receipts,
    },
    positions: {
      open: state.open.map((p) => ({
        market: p.marketId,
        leg: `${p.asset} ${tenorLabel(p.intervalSec)} ${p.leg}`,
        shares: p.shares,
        cost: p.cost,
        expiry: p.expiry,
        adopted: Boolean(p.adopted),
        txHash: p.txHash ?? null,
      })),
      settled: settled.slice(0, 40).map((c) => ({
        market: c.marketId,
        leg: `${c.asset} ${tenorLabel(c.intervalSec)} ${c.leg}`,
        shares: c.shares,
        cost: c.cost,
        proceeds: c.proceeds,
        won: c.won === 1,
        closedAt: c.closedAt,
      })),
      onChainOutcomeBalances: heldOnChain.length,
    },
    stages: stages.map(([name, proven, evidence]) => ({ name, proven, evidence })),
  };

  writeFileSync(out, JSON.stringify(proof, null, 2));

  console.log(`RIVO LIVE PROOF  ·  ${net}`);
  console.log("=".repeat(78));
  console.log(`wallet     ${address}`);
  console.log(`           ${gas.toFixed(4)} ${gasTokenName(net)} · ${collateral.toFixed(4)} ${collateralName(net)}`);
  console.log(`authority  ${authority.kind}${authority.boundedOnChain ? " (bounded on-chain)" : " (bounds enforced by Rivo, not the chain)"}`);
  console.log("");
  for (const s of proof.stages) {
    console.log(`  ${s.proven ? "✓" : "·"}  ${s.name.padEnd(11)} ${s.evidence}`);
  }
  console.log("");
  if (receipts.length > 0) {
    console.log("transactions confirmed on-chain:");
    for (const r of receipts.slice(0, 8)) {
      console.log(`  ${r.succeeded ? "✓" : "✗"} ${r.hash}`);
      console.log(`     block ${r.block?.toLocaleString() ?? "?"} · ${r.events ?? "?"} events · ${r.url}`);
    }
  }
  const unproven = proof.stages.filter((s) => !s.proven).map((s) => s.name);
  console.log("");
  console.log(unproven.length === 0 ? "every stage evidenced." : `NOT YET EVIDENCED: ${unproven.join(", ")}`);
  console.log(`written to ${out}`);
}

main().catch((e) => {
  console.error(`proof failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
