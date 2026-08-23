// One portfolio, one pass.
//
// Everything a cycle needs that is specific to a USER is assembled here, and
// nothing of it touches `process.env`. That is the property that makes a fleet
// possible: two portfolios running in the same process at the same moment sign
// as two different wallets, spend two different budgets, and neither can change
// what the other does.
//
// The order below is not arbitrary, and two steps in it are load-bearing:
//
//   RECOVER runs BEFORE the cycle. A pass that allocates while a transaction
//   from the previous process is unaccounted for is reasoning from a portfolio
//   that might already own something it is about to buy.
//
//   RENEW runs between recovery and the cycle, and again is checked after it. A
//   lease that lapsed mid-pass means somebody else may now be running this
//   portfolio, and the correct response is to throw away our work rather than
//   write it — see the note on `StaleStateError`.

import { Indexer } from "../core/indexer.js";
import { resolvePolicy } from "../portfolio/policy.js";
import { cycle, type CycleReport } from "../runtime/loop.js";
import { executorFor } from "../runtime/executor.js";
import { RpcReceiptReader, defaultRpcUrl } from "../runtime/receipt.js";
import { PrivyDelegatedAuthority, looksRevoked } from "../signing/privy.js";
import { PRODUCTION_STRATEGY } from "../research/gating.js";
import { PostgresExecutionLedger } from "../ledger/postgres.js";
import { RecordingExecutor, recover } from "../ledger/recording.js";
import { PostgresDecisionLog, PostgresStateStore } from "../store/postgres.js";
import { StaleStateError } from "../store/types.js";
import { permissionFor, scheduleNext, setState, type Portfolio } from "../db/portfolios.js";
import { modeIntendsExecution, type Permission } from "../runtime/permission.js";
import { setDelegated } from "../db/accounts.js";
import { record, recordOnce } from "../db/events.js";
import { held, renew, type Lease } from "../db/leases.js";
import { equityOf } from "../runtime/state.js";

export interface CycleOptions {
  /** How long until this portfolio is looked at again. */
  intervalSec: number;
  /** Shared per network — an Indexer is read-only and its caches are worth keeping. */
  indexer: Indexer;
  out?: (line: string) => void;
}

export interface CycleOutcome {
  portfolioId: string;
  ok: boolean;
  /** Absent when the cycle did not complete. */
  report?: CycleReport;
  error?: string;
  recovered?: { resolved: number; orphaned: number };
}

/**
 * Run one pass for one portfolio, under its own user's authority.
 *
 * Never throws. A worker managing forty portfolios must not lose thirty-nine of
 * them because one had a bad cycle, so failure is a value here rather than an
 * exception — recorded as an event, returned to the caller, and the portfolio is
 * scheduled to try again.
 */
export async function runPortfolioCycle(
  portfolio: Portfolio,
  lease: Lease,
  opts: CycleOptions,
): Promise<CycleOutcome> {
  const out = opts.out ?? (() => {});
  const id = portfolio.id;
  const ledger = new PostgresExecutionLedger();

  try {
    const store = new PostgresStateStore(id);
    const log = new PostgresDecisionLog(id);
    // An orphaned position row means something removed a position without
    // recording how it ended. The store closes it so it cannot resurrect; this
    // makes sure a person finds out, because the cause is a bug upstream of the
    // store and it will not fix itself.
    store.onOrphan = (message) => {
      out(`  ${message}`);
      void record(id, "position.orphaned", "error", message).catch(() => undefined);
    };
    const state = await store.load();

    // The five things that must agree before capital moves.
    //
    // `permissionFor` asks all of them: strategy state, execution mode,
    // network, delegation and signer. It replaced a check that asked only the
    // last two, which is how a strategy this repository's own evidence calls
    // economically REJECTED could reach `executor.buy()` with a real balance
    // behind it. Portfolio risk is unchanged and still runs after this.
    const authority = new PrivyDelegatedAuthority(
      { walletId: portfolio.privyWalletId ?? "", address: portfolio.address },
      portfolio.delegated,
    );
    let permission: Permission = permissionFor(portfolio, authority.available());
    let live = permission.mayMoveCapital;

    // Say why, once, rather than leaving a portfolio silently not trading.
    if (!live && modeIntendsExecution(portfolio.policy.mode)) {
      await recordOnce(id, "execution.blocked", "warn", permission.summary, {
        mode: portfolio.policy.mode,
        reasons: permission.reasons,
        strategy: PRODUCTION_STRATEGY.id,
        strategyState: PRODUCTION_STRATEGY.state,
        network: portfolio.network,
      });
      out(`  no capital will move — ${permission.reasons.join(", ")}`);
    }

    // Ask for the signer once, before the cycle, rather than discovering it is
    // gone one order at a time.
    //
    // A user can withdraw Rivo's permission inside Privy without telling Rivo,
    // and the database would go on believing it may sign — so every cycle would
    // attempt orders that cannot be signed, forever. The same principle the
    // reconciler applies to holdings applies here: the authority that issues the
    // grant is the one that decides whether it still stands, and local state
    // loses to it.
    //
    // Only a revocation-shaped failure demotes. A timeout must not switch a
    // user's Autopilot off.
    if (live) {
      try {
        await authority.account();
      } catch (e) {
        if (looksRevoked(e)) {
          live = false;
          permission = permissionFor(portfolio, false);
          await setDelegated(portfolio.userId, portfolio.walletId, false);
          await setState(null, id, "paused", "Rivo's permission to sign for this wallet was withdrawn");
          await record(id, "autopilot.revoked", "warn",
            "Privy refused to sign for this portfolio, so the permission has been withdrawn. " +
              "Autopilot is paused; re-enable it to grant permission again.",
            { address: portfolio.address });
          out(`  signing permission withdrawn — pausing and running this cycle in Shadow Mode`);
        } else {
          // Not a revocation. Run dry this pass rather than trading blind, and
          // say so, but leave the grant and the portfolio's state alone.
          live = false;
          permission = permissionFor(portfolio, false);
          await recordOnce(id, "signer.unavailable", "warn",
            `Could not obtain a signer this cycle: ${e instanceof Error ? e.message : String(e)}`);
          out(`  signer unavailable this cycle — running dry, grant left intact`);
        }
      }
    }

    const inner = executorFor(authority, !live);
    if (state.dryRun !== (inner.mode === "dry")) {
      // A portfolio that switches between shadow and live is a fact worth
      // recording: every P&L number before the switch means something different
      // from every number after it.
      await record(id, live ? "autopilot.live" : "autopilot.shadow", "info",
        live ? "Autopilot is now placing real orders." : "Autopilot is running in Shadow Mode — no orders will be sent.",
        { address: portfolio.address });
      state.dryRun = inner.mode === "dry";
    }

    const executor = new RecordingExecutor(inner, {
      portfolioId: id,
      ledger,
      note: (m) => out(`  ${m}`),
    });

    // --- RECOVER, before anything reasons about the portfolio ---------------
    const receipts = new RpcReceiptReader(defaultRpcUrl(portfolio.network));
    const rec = await recover(ledger, id, receipts);
    for (const d of rec.details) out(`  recovered: ${d}`);
    if (rec.orphaned > 0) {
      await record(id, "execution.orphaned", "warn",
        `${rec.orphaned} execution(s) could not be resolved against the chain and are recorded as orphaned. ` +
          `Position truth comes from on-chain reconciliation, which runs this cycle.`,
        { orphaned: rec.orphaned, resolved: rec.resolved });
    }

    // --- STILL OURS? -------------------------------------------------------
    if (!(await renew(lease))) {
      return { portfolioId: id, ok: false, error: "lost the lease before the cycle started" };
    }

    const profile = resolvePolicy(portfolio.policy);
    const report = await cycle(state, { idx: opts.indexer, executor, store, log, profile, out });

    // A breaker firing is the one thing that must reach a person. It means the
    // portfolio stopped trading and will not resume on its own.
    if (report.halted) {
      await setState(null, id, "halted", report.halted);
      await record(id, "breaker.halted", "error", `Autopilot halted: ${report.halted}`, {
        equity: report.equity,
        cash: report.cash,
      });
    }
    for (const d of report.reconciled) {
      if (d.action === "kept-pending") continue;
      await recordOnce(id, `reconcile.${d.action}`, "warn",
        `${d.action} ${d.leg} on ${d.marketId.slice(0, 10)}… — ${d.detail}`,
        { marketId: d.marketId, leg: d.leg, stateShares: d.stateShares, chainShares: d.chainShares });
    }

    await scheduleNext(id, opts.intervalSec);
    return { portfolioId: id, ok: true, report, recovered: { resolved: rec.resolved, orphaned: rec.orphaned } };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);

    if (e instanceof StaleStateError) {
      // Two workers on one portfolio. The lease should have prevented it, so
      // this is a bug rather than an operating condition, and it is recorded as
      // one — loudly, with the portfolio left alone rather than "repaired".
      await record(id, "lease.violated", "error",
        `A save was refused because the portfolio moved underneath this worker. ` +
          `The lease did not prevent a concurrent run, which should be impossible. ${message}`,
        { workerId: lease.workerId, fence: lease.fence }).catch(() => undefined);
      return { portfolioId: id, ok: false, error: message };
    }

    // A cycle that failed still has to be scheduled, or a transient indexer
    // outage retires a portfolio permanently.
    await recordOnce(id, "cycle.failed", "warn", `Cycle failed: ${message}`, {}).catch(() => undefined);
    await scheduleNext(id, opts.intervalSec).catch(() => undefined);
    return { portfolioId: id, ok: false, error: message };
  }
}

/**
 * A one-line summary of a pass, for the worker log.
 *
 * Total, rather than assuming a successful outcome carries a report. It does
 * not always: a pass that lost its lease before starting returns ok with
 * nothing to report, and a `!` here turned that into a thrown TypeError inside
 * the worker's own logging — which the worker then counted as a failed cycle.
 * A logging line must never be able to fail a trading pass.
 */
export function summarise(portfolio: Portfolio, outcome: CycleOutcome): string {
  const who = `${portfolio.address.slice(0, 10)}…`;
  if (!outcome.ok) return `${who} FAILED — ${outcome.error}`;
  const r = outcome.report;
  if (!r) return `${who} completed with nothing to report`;
  return (
    `${who} cycle ${r.cycle}  ${r.windows}w/${r.legs}l  ` +
    `bought ${r.bought} (${r.spent.toFixed(2)})  settled ${r.settled}  ` +
    `equity ${r.equity.toFixed(2)}  cash ${r.cash.toFixed(2)}` +
    (r.halted ? `  HALTED ${r.halted}` : "")
  );
}

/** Total value under management, for the worker's own reporting. */
export const equity = equityOf;
