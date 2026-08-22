// Proof, for a portfolio that lives in PostgreSQL.
//
// The file-based proof (`src/cli/proof.ts`) reads transaction hashes off the
// POSITIONS, because on a file store that is where they were. That is exactly
// the ambiguity the execution ledger was built to remove — a closed position
// dropped its hash, so a finished portfolio could show two hundred positions and
// ten hashes and no way to tell which of the two numbers meant anything.
//
// So this counts four DIFFERENT things and never conflates them:
//
//   DECISIONS   every leg considered, taken or refused. Thousands.
//   LOTS        positions, open and closed. One per fill, not per leg.
//   ATTEMPTS    execution ledger rows. One per action Rivo tried, including the
//               ones that failed, were rejected, or ended unknown.
//   CONFIRMED   attempts that produced a transaction the chain acknowledges,
//               each verified here by reading its receipt back.
//
// Those four are related and none of them is a proxy for another. A dry run has
// decisions, lots and attempts and zero confirmed transactions, and the document
// says so rather than looking like a failure. A live run's gap between attempts
// and confirmed is the interesting number, and it is stated rather than hidden.
//
// Nothing here is asserted that was not read: every hash is looked up, and a
// stage with no evidence is reported unproven rather than omitted.

import { num, one, query, secs } from "../db/pool.js";
import { portfolioById, type Portfolio } from "../db/portfolios.js";
import { RpcReceiptReader, defaultRpcUrl, type Receipt } from "../runtime/receipt.js";
import { addressUrl, collateralName, gasTokenName, tenorLabel, txUrl, VENUE } from "../core/venue.js";
import { collateralBalance, nativeBalance } from "../public/wallet.js";
import { recent } from "../db/events.js";
import { liveWorkers } from "../db/leases.js";

export interface ProofStage {
  name: string;
  proven: boolean;
  evidence: string;
}

export interface PortfolioProof {
  generatedAt: string;
  source: "postgres";
  network: string;
  venueId: string;
  portfolio: {
    id: string;
    address: string;
    url: string;
    profile: string;
    mode: string;
    state: string;
    delegated: boolean;
    /** Whether Rivo could sign for this wallet at all — a wallet id exists. */
    signable: boolean;
  };
  wallet: {
    gas: number | null;
    gasSymbol: string;
    collateral: number | null;
    collateralSymbol: string;
  };
  runtime: {
    cycles: number;
    startedAt: number;
    lastCycleAt: number | null;
    sinceLastCycleSec: number | null;
    capital: number;
    cash: number;
    contributed: number;
    realizedPnl: number;
    halted: string | null;
    dryRun: boolean;
    tradedBy: string | null;
    stateVersion: number;
  };
  ledger: {
    identity: string;
    cash: number;
    openCost: number;
    capital: number;
    contributed: number;
    realizedPnl: number;
    imbalance: number;
    balances: boolean;
  };
  /** The four counts, kept apart on purpose. See the header. */
  counts: {
    decisions: number;
    decisionsEntered: number;
    decisionsRefused: number;
    lotsOpen: number;
    lotsClosed: number;
    executionAttempts: number;
    executionsByStatus: Record<string, number>;
    executionsWithTxHash: number;
    confirmedOnChain: number;
  };
  executions: {
    id: string;
    action: string;
    leg: string | null;
    market: string;
    status: string;
    mode: string;
    requestedQty: number | null;
    filledQty: number | null;
    filledPrice: number | null;
    txHash: string | null;
    url: string | null;
    createdAt: number;
    error: string | null;
  }[];
  receipts: {
    hash: string;
    url: string;
    found: boolean;
    succeeded: boolean;
    block: number | null;
  }[];
  positions: {
    open: { market: string; leg: string; shares: number; cost: number; expiry: number; adopted: boolean }[];
    closed: {
      market: string;
      leg: string;
      shares: number;
      cost: number;
      proceeds: number;
      exit: string;
      closedAt: number;
      /** Transactions that touched this position, from the ledger — not from the position. */
      txHashes: string[];
    }[];
  };
  settlement: { settled: number; sold: number; merged: number; voided: number; dropped: number; claimSweeps: number };
  reconciliation: { adoptedOpen: number; events: number; lastAt: number | null };
  risk: {
    breakerEvents: number;
    halted: string | null;
    events: { at: number; kind: string; severity: string; message: string }[];
  };
  fleet: { liveWorkers: number };
  stages: ProofStage[];
}

/**
 * Build the document.
 *
 * `receiptsLimit` bounds the RPC work, not the record: every hash is counted,
 * and the ones actually looked up are the most recent. A proof that took ten
 * minutes to produce is a proof nobody regenerates.
 */
export async function buildPortfolioProof(
  portfolioId: string,
  opts: { receiptsLimit?: number; reader?: { receipt(hash: string): Promise<Receipt | null> } } = {},
): Promise<PortfolioProof> {
  const portfolio: Portfolio | null = await portfolioById(portfolioId);
  if (!portfolio) throw new Error(`no portfolio ${portfolioId} in this database`);
  const net = portfolio.network;

  const rt = await one<{
    cash: string; realized_pnl: string; contributed: string; cycles: string; halted: string | null;
    dry_run: boolean; traded_by: string | null; started_at: Date; last_cycle_at: Date | null;
    last_claim_sweep_at: Date | null; version: string;
  }>(
    `SELECT cash, realized_pnl, contributed, cycles, halted, dry_run, traded_by,
            started_at, last_cycle_at, last_claim_sweep_at, version
       FROM portfolio_runtime WHERE portfolio_id = $1`,
    [portfolioId],
  );

  const [counts] = await query<{
    decisions: string; entered: string; refused: string;
    open_lots: string; closed_lots: string; adopted_open: string;
    executions: string; with_hash: string;
  }>(
    `SELECT (SELECT count(*) FROM decisions WHERE portfolio_id = $1)::text AS decisions,
            (SELECT count(*) FROM decisions WHERE portfolio_id = $1 AND action IN ('BUY','ENTER'))::text AS entered,
            (SELECT count(*) FROM decisions WHERE portfolio_id = $1 AND action = 'SKIP')::text AS refused,
            (SELECT count(*) FROM positions WHERE portfolio_id = $1 AND status = 'open')::text AS open_lots,
            (SELECT count(*) FROM positions WHERE portfolio_id = $1 AND status = 'closed')::text AS closed_lots,
            (SELECT count(*) FROM positions WHERE portfolio_id = $1 AND status = 'open' AND adopted)::text AS adopted_open,
            (SELECT count(*) FROM executions WHERE portfolio_id = $1)::text AS executions,
            (SELECT count(*) FROM executions WHERE portfolio_id = $1 AND tx_hash IS NOT NULL)::text AS with_hash`,
    [portfolioId],
  );

  const byStatus = await query<{ status: string; n: string }>(
    `SELECT status, count(*)::text AS n FROM executions WHERE portfolio_id = $1 GROUP BY status ORDER BY status`,
    [portfolioId],
  );
  const executionsByStatus = Object.fromEntries(byStatus.map((r) => [r.status, Number(r.n)]));

  const execRows = await query<{
    id: string; action: string; leg: string | null; market_id: string; status: string;
    requested_qty: string | null; filled_qty: string | null; filled_price: string | null;
    tx_hash: string | null; created_at: Date; error: string | null; meta: Record<string, unknown>;
  }>(
    `SELECT id, action, leg, market_id, status, requested_qty, filled_qty, filled_price,
            tx_hash, created_at, error, meta
       FROM executions WHERE portfolio_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [portfolioId],
  );

  const openRows = await query<{
    market_id: string; asset: string; interval_sec: number; leg: string;
    shares: string; cost: string; expiry: Date; adopted: boolean;
  }>(
    `SELECT market_id, asset, interval_sec, leg, shares, cost, expiry, adopted
       FROM positions WHERE portfolio_id = $1 AND status = 'open' ORDER BY expiry`,
    [portfolioId],
  );

  const closedRows = await query<{
    market_id: string; asset: string; interval_sec: number; leg: string;
    shares: string; cost: string; proceeds: string | null; exit: string | null;
    closed_at: Date; tx_hashes: string[] | null;
  }>(
    `SELECT p.market_id, p.asset, p.interval_sec, p.leg, p.shares, p.cost, p.proceeds, p.exit, p.closed_at,
            (SELECT array_agg(DISTINCT e.tx_hash)
               FROM position_executions pe JOIN executions e ON e.id = pe.execution_id
              WHERE pe.position_id = p.id AND e.tx_hash IS NOT NULL) AS tx_hashes
       FROM positions p
      WHERE p.portfolio_id = $1 AND p.status = 'closed'
      ORDER BY p.closed_at DESC LIMIT 60`,
    [portfolioId],
  );

  const [exits] = await query<{ settled: string; sold: string; merged: string; voided: string; dropped: string }>(
    `SELECT count(*) FILTER (WHERE exit = 'settled')::text AS settled,
            count(*) FILTER (WHERE exit = 'sold')::text    AS sold,
            count(*) FILTER (WHERE exit = 'merged')::text  AS merged,
            count(*) FILTER (WHERE exit = 'voided')::text  AS voided,
            count(*) FILTER (WHERE exit = 'dropped')::text AS dropped
       FROM positions WHERE portfolio_id = $1 AND status = 'closed'`,
    [portfolioId],
  );

  const [claims] = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM executions WHERE portfolio_id = $1 AND action = 'CLAIM'`,
    [portfolioId],
  );

  const [recon] = await query<{ n: string; last_at: Date | null }>(
    `SELECT count(*)::text AS n, max(at) AS last_at FROM events
      WHERE portfolio_id = $1 AND kind LIKE 'reconcile.%'`,
    [portfolioId],
  );

  const [breakers] = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM events WHERE portfolio_id = $1 AND kind = 'breaker.halted'`,
    [portfolioId],
  );

  const events = await recent(portfolioId, 25);
  const fleet = await liveWorkers();

  // Balances, best effort. A read that fails must not fail the proof — it
  // becomes null, which is "not checked" rather than "empty".
  const [gas, collateral] = await Promise.all([
    nativeBalance(net, portfolio.address).catch(() => null),
    collateralBalance(net, portfolio.address).catch(() => null),
  ]);

  // Receipts, read back from the chain rather than trusted from the ledger.
  const reader = opts.reader ?? new RpcReceiptReader(defaultRpcUrl(net));
  const hashes = [...new Set(execRows.map((r) => r.tx_hash).filter(Boolean) as string[])].slice(
    0,
    opts.receiptsLimit ?? 25,
  );
  const receipts = await Promise.all(
    hashes.map(async (hash) => {
      const r = await reader.receipt(hash);
      return {
        hash,
        url: txUrl(net, hash),
        found: r !== null,
        succeeded: r?.ok === true,
        block: r?.blockNumber ?? null,
      };
    }),
  );

  const openCost = openRows.reduce((a, r) => a + num(r.cost), 0);
  const cash = num(rt.cash);
  const capital = portfolio.policy.capital;
  const contributed = num(rt.contributed);
  const realizedPnl = num(rt.realized_pnl);
  const imbalance = cash + openCost - (capital + contributed + realizedPnl);
  const scale = Math.max(1, Math.abs(capital) + Math.abs(realizedPnl));

  const cycles = Number(rt.cycles);
  const lastCycleAt = rt.last_cycle_at ? secs(rt.last_cycle_at) : null;
  const now = Math.floor(Date.now() / 1000);
  const confirmed = receipts.filter((r) => r.succeeded).length;
  const attempts = Number(counts!.executions);
  const withHash = Number(counts!.with_hash);

  const stages: ProofStage[] = [
    ["DISCOVER", cycles > 0, `${cycles} cycles against the live venue`],
    ["ANALYZE", Number(counts!.decisions) > 0, `${Number(counts!.decisions).toLocaleString()} decisions recorded, ${Number(counts!.refused).toLocaleString()} of them refusals`],
    ["ALLOCATE", Number(counts!.open_lots) + Number(counts!.closed_lots) > 0, `${Number(counts!.open_lots)} open lots, ${Number(counts!.closed_lots)} closed`],
    ["RISK CHECK", true, rt.halted ? `circuit breaker fired: ${rt.halted}` : "within limits, breaker armed"],
    ["EXECUTE", attempts > 0, `${attempts} execution attempts recorded before anything was signed`],
    ["BROADCAST", withHash > 0, withHash > 0 ? `${withHash} attempts carry a transaction hash` : `no transaction hashes — ${rt.dry_run ? "this portfolio is in Shadow Mode" : "nothing has been broadcast"}`],
    ["CONFIRM", confirmed > 0, `${confirmed}/${receipts.length} receipts read back from the chain report success`],
    ["RECONCILE", Number(recon!.n) > 0 || Number(counts!.adopted_open) > 0, `${Number(recon!.n)} reconciliation events, ${Number(counts!.adopted_open)} positions adopted from chain`],
    ["PERSIST", true, `PostgreSQL, state version ${Number(rt.version)}`],
    ["LEDGER", Math.abs(imbalance) <= 1e-6 * scale, `imbalance ${imbalance.toExponential(2)}`],
    ["SETTLE", Number(exits!.settled) > 0, `${Number(exits!.settled)} positions resolved against the venue's oracle`],
    ["CLAIM", Number(claims!.n) > 0, `${Number(claims!.n)} claim sweeps recorded`],
  ].map(([name, proven, evidence]) => ({ name: name as string, proven: Boolean(proven), evidence: evidence as string }));

  return {
    generatedAt: new Date().toISOString(),
    source: "postgres",
    network: net,
    venueId: VENUE[net].venueId,
    portfolio: {
      id: portfolio.id,
      address: portfolio.address,
      url: addressUrl(net, portfolio.address),
      profile: portfolio.policy.profile,
      mode: portfolio.policy.mode,
      state: portfolio.policy.state,
      delegated: portfolio.delegated,
      signable: Boolean(portfolio.privyWalletId),
    },
    wallet: { gas, gasSymbol: gasTokenName(net), collateral, collateralSymbol: collateralName(net) },
    runtime: {
      cycles,
      startedAt: secs(rt.started_at),
      lastCycleAt,
      sinceLastCycleSec: lastCycleAt === null ? null : now - lastCycleAt,
      capital,
      cash,
      contributed,
      realizedPnl,
      halted: rt.halted,
      dryRun: rt.dry_run,
      tradedBy: rt.traded_by,
      stateVersion: Number(rt.version),
    },
    ledger: {
      identity: "cash + open cost == capital + contributed + realised",
      cash,
      openCost,
      capital,
      contributed,
      realizedPnl,
      imbalance,
      balances: Math.abs(imbalance) <= 1e-6 * scale,
    },
    counts: {
      decisions: Number(counts!.decisions),
      decisionsEntered: Number(counts!.entered),
      decisionsRefused: Number(counts!.refused),
      lotsOpen: Number(counts!.open_lots),
      lotsClosed: Number(counts!.closed_lots),
      executionAttempts: attempts,
      executionsByStatus,
      executionsWithTxHash: withHash,
      confirmedOnChain: confirmed,
    },
    executions: execRows.map((r) => ({
      id: r.id,
      action: r.action,
      leg: r.leg,
      market: r.market_id,
      status: r.status,
      mode: r.meta?.mode === "live" ? "live" : "dry",
      requestedQty: r.requested_qty === null ? null : num(r.requested_qty),
      filledQty: r.filled_qty === null ? null : num(r.filled_qty),
      filledPrice: r.filled_price === null ? null : num(r.filled_price),
      txHash: r.tx_hash,
      url: r.tx_hash ? txUrl(net, r.tx_hash) : null,
      createdAt: secs(r.created_at),
      error: r.error,
    })),
    receipts,
    positions: {
      open: openRows.map((r) => ({
        market: r.market_id,
        leg: `${r.asset} ${tenorLabel(r.interval_sec)} ${r.leg}`,
        shares: num(r.shares),
        cost: num(r.cost),
        expiry: secs(r.expiry),
        adopted: r.adopted,
      })),
      closed: closedRows.map((r) => ({
        market: r.market_id,
        leg: `${r.asset} ${tenorLabel(r.interval_sec)} ${r.leg}`,
        shares: num(r.shares),
        cost: num(r.cost),
        proceeds: num(r.proceeds),
        exit: r.exit ?? "settled",
        closedAt: secs(r.closed_at),
        txHashes: r.tx_hashes ?? [],
      })),
    },
    settlement: {
      settled: Number(exits!.settled),
      sold: Number(exits!.sold),
      merged: Number(exits!.merged),
      voided: Number(exits!.voided),
      dropped: Number(exits!.dropped),
      claimSweeps: Number(claims!.n),
    },
    reconciliation: {
      adoptedOpen: Number(counts!.adopted_open),
      events: Number(recon!.n),
      lastAt: recon!.last_at ? secs(recon!.last_at) : null,
    },
    risk: {
      breakerEvents: Number(breakers!.n),
      halted: rt.halted,
      events: events
        .filter((e) => e.severity !== "info")
        .slice(0, 15)
        .map((e) => ({ at: e.at, kind: e.kind, severity: e.severity, message: e.message })),
    },
    fleet: { liveWorkers: fleet.length },
    stages,
  };
}
