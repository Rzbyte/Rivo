// `npm run report -- --portfolio <id>` — what Rivo has done, out of PostgreSQL.
//
// Same audiences as the file report, same answer: every leg considered, priced,
// and accepted or refused, with the constraint that bound. What the database
// adds is that the constraint histogram is a query rather than a scan of a log
// tail — so "what actually stops this portfolio trading" is answerable over the
// whole history instead of the recent few thousand lines.
//
// Counts here are CUMULATIVE EVALUATIONS, not concurrent markets. The venue
// lists eight windows at a time; a run reporting thousands has looked at those
// eight repeatedly across cycles, and mislabelling that as breadth would be the
// easiest number in the whole submission to falsify.

import { num, one, query, secs } from "../db/pool.js";
import { portfolioById } from "../db/portfolios.js";
import { buildView } from "../db/view.js";
import { recent } from "../db/events.js";
import { tenorLabel } from "../core/venue.js";

const money = (x: number) => `${x >= 0 ? "+" : "-"}${Math.abs(x).toFixed(2)}`;
const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "n/a");

export async function reportPortfolio(portfolioId: string): Promise<void> {
  const portfolio = await portfolioById(portfolioId);
  if (!portfolio) throw new Error(`no portfolio ${portfolioId} in this database`);
  const view = await buildView(portfolio);

  console.log("RIVO · portfolio report");
  console.log("=".repeat(84));
  console.log(`portfolio  ${portfolio.id}`);
  console.log(`wallet     ${portfolio.address}`);
  console.log(
    `mode       ${view.autopilot.mode}/${view.autopilot.state}   profile ${view.profile}   ` +
      `${view.runtime.dryRun ? "SHADOW" : "LIVE"}${view.runtime.halted ? `   HALTED: ${view.runtime.halted}` : ""}`,
  );
  console.log(
    `runtime    ${view.runtime.cycles.toLocaleString()} cycles since ${new Date(view.runtime.startedAt * 1000).toISOString()}` +
      (view.runtime.sinceLastCycleSec === null ? "   (no cycle yet)" : `   last ${view.runtime.sinceLastCycleSec}s ago`),
  );
  console.log(`worker     ${view.worker.alive} live in the fleet`);
  if (view.autopilot.blocker) console.log(`blocked    ${view.autopilot.blocker}`);

  // --- portfolio ----------------------------------------------------------
  console.log("");
  console.log("PORTFOLIO");
  console.log("-".repeat(84));
  console.log(`  capital committed          ${view.capital.toFixed(2)}`);
  console.log(`  available                  ${view.cash.toFixed(2)}   (${pct(view.capital > 0 ? view.cash / view.capital : 0)})`);
  console.log(`  deployed                   ${view.deployed.toFixed(2)}   (${pct(view.utilisation)} of the ${view.limits.deployedCap.toFixed(2)} ceiling)`);
  console.log(`  equity                     ${view.equity.toFixed(2)}`);
  console.log(`  realised P&L               ${money(view.realizedPnl)}   (${pct(view.capital > 0 ? view.realizedPnl / view.capital : 0)} of capital)`);
  if (view.contributed !== 0) {
    console.log(`  contributed                ${money(view.contributed)}   assets adopted from the chain, cost basis ESTIMATED`);
  }

  console.log("");
  console.log("  correlated exposure, per 1% move in the underlying");
  for (const e of view.exposure) {
    console.log(
      `    ${e.asset.padEnd(4)} ${(e.delta >= 0 ? "+" : "") + e.delta.toFixed(3).padStart(8)}  of ±${e.cap.toFixed(2)}  ` +
        `${String(Math.round(e.used * 100)).padStart(3)}% used   ${e.deployed.toFixed(2)} committed`,
    );
  }

  // --- what it decided ----------------------------------------------------
  const [d] = await query<{ total: string; entered: string; refused: string; managed: string }>(
    `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE action IN ('BUY','ENTER'))::text AS entered,
            count(*) FILTER (WHERE action = 'SKIP')::text AS refused,
            count(*) FILTER (WHERE action IN ('REDUCE','EXIT','RECOVER','HOLD'))::text AS managed
       FROM decisions WHERE portfolio_id = $1`,
    [portfolioId],
  );
  console.log("");
  console.log("DECISIONS  (cumulative evaluations, not concurrent markets)");
  console.log("-".repeat(84));
  console.log(`  considered                 ${Number(d!.total).toLocaleString()}`);
  console.log(`  entered                    ${Number(d!.entered).toLocaleString()}`);
  console.log(`  managed (reduce/exit)      ${Number(d!.managed).toLocaleString()}`);
  console.log(`  refused                    ${Number(d!.refused).toLocaleString()}`);

  // The histogram that matters: what actually stops this portfolio trading.
  const bindings = await query<{ binding: string; n: string }>(
    `SELECT binding, count(*)::text AS n FROM decisions
      WHERE portfolio_id = $1 AND action = 'SKIP'
      GROUP BY binding ORDER BY count(*) DESC LIMIT 12`,
    [portfolioId],
  );
  if (bindings.length > 0) {
    console.log("");
    console.log("  what refused them");
    const top = Math.max(...bindings.map((b) => Number(b.n)));
    for (const b of bindings) {
      const n = Number(b.n);
      const bar = "█".repeat(Math.max(1, Math.round((n / top) * 24)));
      console.log(`    ${String(n).padStart(6)}  ${bar.padEnd(24)}  ${b.binding.slice(0, 44)}`);
    }
  }

  // Refusals where the correlated budget was the binding reason, which is the
  // behaviour the whole product exists to demonstrate.
  const [corr] = await query<{ n: string; asset: string | null }>(
    `SELECT count(*)::text AS n, mode() WITHIN GROUP (ORDER BY asset) AS asset
       FROM decisions
      WHERE portfolio_id = $1 AND action = 'SKIP' AND binding LIKE '%delta budget%'`,
    [portfolioId],
  );
  if (Number(corr!.n) > 0) {
    console.log("");
    console.log(
      `  ${Number(corr!.n).toLocaleString()} refusals were the correlated exposure budget itself — a positive-edge leg` +
        ` declined because the portfolio already held that view at another tenor.`,
    );
  }

  // --- what it executed ---------------------------------------------------
  const execs = await query<{ action: string; status: string; n: string; hashes: string }>(
    `SELECT action, status, count(*)::text AS n, count(tx_hash)::text AS hashes
       FROM executions WHERE portfolio_id = $1 GROUP BY action, status ORDER BY action, status`,
    [portfolioId],
  );
  console.log("");
  console.log("EXECUTIONS  (attempts, recorded before anything is signed)");
  console.log("-".repeat(84));
  if (execs.length === 0) {
    console.log("  none");
  } else {
    console.log(`  ${"action".padEnd(12)}${"status".padEnd(12)}${"attempts".padStart(9)}${"with tx".padStart(9)}`);
    for (const e of execs) {
      console.log(`  ${e.action.padEnd(12)}${e.status.padEnd(12)}${String(Number(e.n)).padStart(9)}${String(Number(e.hashes)).padStart(9)}`);
    }
  }

  // --- how positions ended ------------------------------------------------
  const closed = await query<{
    exit: string; n: string; staked: string; returned: string; wins: string;
  }>(
    `SELECT exit, count(*)::text AS n, sum(cost)::text AS staked,
            sum(coalesce(proceeds,0))::text AS returned, count(*) FILTER (WHERE won)::text AS wins
       FROM positions WHERE portfolio_id = $1 AND status = 'closed'
      GROUP BY exit ORDER BY count(*) DESC`,
    [portfolioId],
  );
  console.log("");
  console.log("POSITIONS");
  console.log("-".repeat(84));
  console.log(`  open lots                  ${view.counts.openPositions}`);
  console.log(`  closed lots                ${view.counts.closedPositions}`);
  if (closed.length > 0) {
    console.log("");
    console.log(`  ${"how it ended".padEnd(14)}${"n".padStart(6)}${"hit".padStart(8)}${"staked".padStart(10)}${"P&L".padStart(10)}${"ret/stake".padStart(11)}`);
    for (const c of closed) {
      const n = Number(c.n);
      const staked = num(c.staked);
      const ret = num(c.returned);
      console.log(
        `  ${c.exit.padEnd(14)}${String(n).padStart(6)}${pct(Number(c.wins) / n).padStart(8)}` +
          `${staked.toFixed(2).padStart(10)}${money(ret - staked).padStart(10)}${pct(staked > 0 ? (ret - staked) / staked : 0).padStart(11)}`,
      );
    }
  }

  const byTenor = await query<{ interval_sec: number; n: string; staked: string; returned: string; wins: string }>(
    `SELECT interval_sec, count(*)::text AS n, sum(cost)::text AS staked,
            sum(coalesce(proceeds,0))::text AS returned, count(*) FILTER (WHERE won)::text AS wins
       FROM positions WHERE portfolio_id = $1 AND status = 'closed'
      GROUP BY interval_sec ORDER BY interval_sec`,
    [portfolioId],
  );
  if (byTenor.length > 1) {
    console.log("");
    console.log("  by tenor");
    for (const t of byTenor) {
      const n = Number(t.n);
      const staked = num(t.staked);
      const ret = num(t.returned);
      console.log(
        `    ${tenorLabel(t.interval_sec).padEnd(8)}n=${String(n).padStart(4)}  hit ${pct(Number(t.wins) / n).padStart(6)}  ` +
          `staked ${staked.toFixed(2).padStart(8)}  P&L ${money(ret - staked).padStart(8)}`,
      );
    }
  }

  // --- the ledger ---------------------------------------------------------
  const [rt] = await query<{ version: string }>("SELECT version::text FROM portfolio_runtime WHERE portfolio_id = $1", [
    portfolioId,
  ]);
  const openCost = view.deployed;
  const imbalance = view.cash + openCost - (view.capital + view.contributed + view.realizedPnl);
  console.log("");
  console.log("LEDGER");
  console.log("-".repeat(84));
  console.log(`  cash + open cost == capital + contributed + realised`);
  console.log(
    `  ${view.cash.toFixed(2)} + ${openCost.toFixed(2)} == ${view.capital.toFixed(2)} + ${view.contributed.toFixed(2)} + ${view.realizedPnl.toFixed(2)}` +
      `   imbalance ${imbalance.toExponential(2)}`,
  );
  console.log(`  state version ${Number(rt!.version)}`);

  // --- what needed attention ---------------------------------------------
  const events = (await recent(portfolioId, 40)).filter((e) => e.severity !== "info");
  console.log("");
  console.log("EVENTS  (refusals are decisions, not events — they are above)");
  console.log("-".repeat(84));
  if (events.length === 0) {
    console.log("  nothing has needed attention");
  } else {
    for (const e of events.slice(0, 12)) {
      console.log(
        `  ${new Date(e.at * 1000).toISOString().slice(5, 16).replace("T", " ")}  ${e.severity.toUpperCase().padEnd(5)} ` +
          `${e.kind.padEnd(22)} ${e.message.slice(0, 60)}`,
      );
    }
  }

  // --- calibration of what was actually traded ---------------------------
  const [cal] = await one<{ n: string; mean_fair: string; hit: string }>(
    `SELECT count(*)::text AS n, avg(fair_at_entry)::text AS mean_fair,
            (count(*) FILTER (WHERE won))::text AS hit
       FROM positions WHERE portfolio_id = $1 AND status = 'closed' AND exit = 'settled'`,
    [portfolioId],
  ).then((r) => [r]);
  const settledN = Number(cal!.n);
  if (settledN > 0) {
    console.log("");
    console.log("FORECASTS THAT SETTLED");
    console.log("-".repeat(84));
    console.log(
      `  ${settledN} settled · model said ${pct(num(cal!.mean_fair))} on average · ${pct(Number(cal!.hit) / settledN)} actually paid out`,
    );
    console.log(`  Too few to be a calibration result. It is a tally, and it is labelled as one.`);
  }
  console.log("");
}
