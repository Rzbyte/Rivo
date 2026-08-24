"use client";

// What actually happened on-chain.
//
// The five labels here are the product's central promise about honesty, so they
// are never allowed to blur into one another:
//
//   HYPOTHETICAL  an agent decided; nothing was sent
//   SUBMITTED     a transaction went to the chain
//   CONFIRMED     a receipt came back and was read here
//   SETTLED       the contract resolved and the position closed
//   FAILED        it was refused, and the reason is kept
//
// A previous version of this dashboard counted execution ATTEMPTS under the word
// "Transactions" — 1,288 of them over four real ones, an overstatement of three
// hundred times in the flattering direction. That is the mistake these labels
// exist to make impossible.

import { useLive, ago } from "@/lib/live";
import { Nav } from "@/components/Nav";
import { Reveal } from "@/components/Reveal";

interface Run {
  asset: string; leg: string; intervalSec: number; action: string;
  submittedAt: string; txHash: string; blockNumber: string | null;
  filled: number | null; avgPrice: number | null;
  settlement: {
    status: string; source?: string; outcome?: string; won?: boolean;
    closedAt?: string | null; rivoRecord?: string; detail?: string;
  } | null;
}

interface Payload {
  run?: Run | null;
  agent?: {
    id: string; slug: string; label: string; state: string;
    /** Decisions this agent made OUTSIDE any deployment. Never merged into the run. */
    unscopedDecisions: number; unscopedSettled: number; totalDecisions: number;
  } | null;
  global?: { agents: number; shadowDecisions: number; shadowSettled: number };
  portfolio: { id: string; address: string; network: string; mode: string; state: string } | null;
  strategy?: { label: string; state: string; eligibility: string; auc: number; returnOnStake: number };
  worker?: { healthy: boolean; sinceHeartbeatSec: number | null };
  runtime?: { cycles: number; halted: string | null; dryRun: boolean };
  counts?: {
    decisions: number; shadow: number; shadowSettled: number;
    attempts: number; submitted: number; confirmed: number; failed: number;
    openLots: number; closedLots: number;
  };
  transactions?: { hash: string; status: string; action: string; at: string }[];
  note?: string;
  error?: string;
}

const EXPLORER = "https://shannon-explorer.somnia.network/tx/";

export default function Proof() {
  // A confirmed transaction is not going to change, but the counts around it do
  // — attempts, settlements, and the run's own outcome once its contract closes.
  const { data: d, updatedAt } = useLive<Payload>("/api/proof", 15_000);

  return (
    <>
      <Nav />
      <main className="wrap" style={{ paddingTop: 26, paddingBottom: 72 }}>
        <span className="label">Proof</span>
        <h1 style={{ maxWidth: "20ch", marginTop: 8 }}>What actually reached the chain.</h1>
        <p className="lede">
          Decisions, hypothetical shadow runs, submitted transactions and confirmed receipts, counted
          separately and never merged. An attempt is not a transaction; a shadow decision is not a trade.
        </p>

        {!d && <p className="muted" style={{ marginTop: 20 }}>Loading…</p>}
        {d?.error && <div className="banner bad" style={{ marginTop: 20 }}>{d.error}</div>}
        {d && !d.portfolio && !d.error && (
          <div className="banner" style={{ marginTop: 20 }}>
            {d.note ?? "No portfolio is published on this deployment."}
          </div>
        )}

        {d?.portfolio && d.counts && (
          <>
            {/* Who produced this evidence. Without it a reader has counts and
                no idea whose they are, which is the failure the scoping work
                exists to prevent. */}
            <div className="panel" style={{ marginBottom: 14 }}>
              <div className="grid cols-4">
                <Field k="Agent" v={d.agent?.label ?? "built-in reference model"} />
                <Field k="Strategy state" v={d.agent?.state ?? "—"} tone={d.agent?.state === "VALIDATED" ? "pos" : "neg"} />
                <Field k="Mode" v={d.portfolio.mode.replace(/_/g, " ")} />
                <Field k="Run" v={d.portfolio.state} />
              </div>
            </div>

            {d.run && <RunWalkthrough run={d.run} network={d.portfolio.network} />}

            <div className="sec-head">
              <h2>The chain, stage by stage</h2>
              <span className="hint">
                {d.portfolio.network} · {d.portfolio.mode} · {d.portfolio.state} · {ago(updatedAt)}
              </span>
            </div>

            <section className="grid cols-3">
              <Stage k="Decisions" v={d.counts.decisions} s="Every leg considered and recorded, most of them refusals." tone="" />
              <Stage k="Hypothetical" v={d.counts.shadow} s={`Shadow decisions. ${d.counts.shadowSettled} have since settled. Nothing was sent.`} tone="" />
              <Stage k="Attempts" v={d.counts.attempts} s="Written to the ledger BEFORE anything was signed, so a crash leaves a record." tone="" />
              <Stage k="Submitted" v={d.counts.submitted} s="Carry a transaction hash — these reached the chain." tone="pos" />
              <Stage k="Confirmed" v={d.counts.confirmed} s="Receipts read back from Somnia and verified here." tone="pos" />
              <Stage k="Failed" v={d.counts.failed} s="Refused or reverted, each with its reason kept." tone={d.counts.failed > 0 ? "neg" : ""} />
            </section>

            {d.strategy && (
              <div className="banner warn" style={{ marginTop: 14 }}>
                <strong>{d.strategy.label} · {d.strategy.state}.</strong> Execution eligibility:{" "}
                {d.strategy.eligibility}. AUC {d.strategy.auc.toFixed(4)}, return on stake{" "}
                {(d.strategy.returnOnStake * 100).toFixed(2)}% out of sample.
              </div>
            )}

            {d.transactions && d.transactions.length > 0 && (
              <>
                <Reveal title="Every transaction" hint={`${d.counts.submitted} submitted · ${d.counts.confirmed} confirmed`}>
                <div className="panel">
                  <div className="scroll">
                    <table>
                      <thead>
                        <tr>
                          <th className="hide-sm">When</th><th>Action</th><th>Status</th><th>Transaction</th>
                        </tr>
                      </thead>
                      <tbody>
                        {d.transactions.map((t) => (
                          <tr key={t.hash}>
                            <td className="mono hide-sm" style={{ fontSize: 12 }}>{new Date(t.at).toISOString().slice(5, 16).replace("T", " ")}</td>
                            <td className="mono">{t.action}</td>
                            <td className={t.status === "confirmed" ? "pos" : t.status === "failed" ? "neg" : ""}>{t.status.toUpperCase()}</td>
                            <td className="mono" style={{ fontSize: 12 }}>
                              <a href={`${EXPLORER}${t.hash}`} target="_blank" rel="noreferrer">
                                {t.hash.slice(0, 12)}…{t.hash.slice(-8)}
                              </a>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
                </Reveal>
              </>
            )}

            {/* Evidence that is NOT this run's, in its own row, never summed.
                The endpoint used to read `portfolio_id IS NULL OR portfolio_id
                = $1`, which folded every decision the agent made outside any
                deployment into this deployment's totals. An agent is asked
                about every live market on every pass whether or not it is
                deployed, so that pile is the biggest number available and
                adding it made a run look busy. It is real evidence about the
                agent and says nothing about this run. */}
            {(d.agent || d.global) && (
              <Reveal title="Global agent evidence" hint="not this run — never added to the counts above">
                {d.agent && (
                  <div className="panel">
                    <span className="label">{d.agent.label} · outside any deployment</span>
                    <div className="grid cols-3" style={{ marginTop: 10 }}>
                      <Field k="Unscoped decisions" v={d.agent.unscopedDecisions.toLocaleString()} />
                      <Field k="Of those, settled" v={d.agent.unscopedSettled.toLocaleString()} />
                      <Field k="This agent, everywhere" v={d.agent.totalDecisions.toLocaleString()} />
                    </div>
                    <p className="hint" style={{ marginTop: 10, marginBottom: 0 }}>
                      This run recorded <strong>{(d.counts?.shadow ?? 0).toLocaleString()}</strong>. The
                      numbers here belong to the agent across every context it has ever been asked in,
                      and the two are different questions.
                    </p>
                  </div>
                )}
                {d.global && (
                  <div className="panel" style={{ marginTop: 12 }}>
                    <span className="label">Every agent on this deployment</span>
                    <div className="grid cols-3" style={{ marginTop: 10 }}>
                      <Field k="Agents registered" v={String(d.global.agents)} />
                      <Field k="Shadow decisions" v={d.global.shadowDecisions.toLocaleString()} />
                      <Field k="Resolved against settlement" v={d.global.shadowSettled.toLocaleString()} />
                    </div>
                  </div>
                )}
              </Reveal>
            )}

            <div className="sec-head">
              <h2>The loop</h2>
              <span className="hint">every settled contract becomes new evidence</span>
            </div>
            <div className="panel">
              <ol className="flow">
                <li><span className="n">Market</span><p>A live Event Contract quotes a probability.</p></li>
                <li><span className="n">Prediction</span><p>An agent says what it thinks, and Rivo records both.</p></li>
                <li><span className="n">Decision</span><p>The gate, the risk engine and the signer all have to agree before capital moves. Most legs are refused here.</p></li>
                <li><span className="n">Outcome</span><p>The contract settles. The position closes and the shadow record resolves against the same truth.</p></li>
                <li><span className="n">Evidence</span><p>That outcome joins the calibration dataset and the agent's validation record — so the next answer is measured against one more settled fact.</p></li>
              </ol>
            </div>
          </>
        )}
      </main>
    </>
  );
}

function Stage({ k, v, s, tone }: { k: string; v: number; s: string; tone: string }) {
  return (
    <div className="panel stat">
      <span className="label">{k}</span>
      <span className={`value ${tone}`}>{v.toLocaleString()}</span>
      <span className="sub">{s}</span>
    </div>
  );
}

function Field({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <div>
      <span className="label" style={{ display: "block", marginBottom: 4 }}>{k}</span>
      <span className={`mono ${tone ?? ""}`} style={{ fontSize: 14, fontWeight: 600 }}>{v}</span>
    </div>
  );
}

/**
 * One order, from decision to settlement.
 *
 * The stage counts elsewhere say what a deployment has done in total. This says
 * what happened to a single order, which is the thing a reader can follow —
 * and the reason it picks the most recent CONFIRMED transaction rather than the
 * most recent attempt is that a run ending at "submitted" is a story without a
 * last page.
 */
function RunWalkthrough({ run, network }: { run: Run; network: string }) {
  const explorer = `${EXPLORER}${run.txHash}`;
  // Every stage the shared pipeline actually has, in the order it runs them.
  //
  // Two were missing and both mattered. VENUE NORMALISATION is where a size is
  // rounded to something DreamDEX will accept — the step that used to live
  // inside the executor and turn a deterministic refusal into an execution
  // failure. LEDGER PERSISTED is where the attempt is written down BEFORE
  // signing, which is the thing that makes a crash recoverable rather than a
  // position Rivo owns and has forgotten.
  //
  // Statuses come from the fixed vocabulary so nothing on this page can be
  // read as more than it is: PASSED and NORMALISED are pre-chain facts,
  // SUBMITTED means a hash exists, CONFIRMED means a receipt was read back.
  const steps: [string, string, string, string][] = [
    ["Agent decision", "PASSED", `${run.asset} ${run.leg} · ${Math.round(run.intervalSec / 60)}m`, run.action],
    ["Risk check", "PASSED", "Strategy gate, exposure limits and the drawdown breaker all agreed", ""],
    [
      "Venue normalisation",
      "NORMALISED",
      run.filled !== null
        ? `${run.filled.toFixed(2)} shares — a size DreamDEX accepts`
        : "Rounded down to the venue lot",
      "",
    ],
    [
      "Order submitted",
      "SUBMITTED",
      run.filled !== null && run.avgPrice !== null
        ? `Filled ${run.filled.toFixed(2)} at ${run.avgPrice.toFixed(3)}`
        : "Sent to DreamDEX",
      "",
    ],
    ["Somnia confirmed", "CONFIRMED", `${run.txHash.slice(0, 14)}…${run.txHash.slice(-8)}`, run.blockNumber ? `block ${run.blockNumber}` : ""],
    ["Ledger persisted", "RECORDED", "Written before signing, so a crash leaves a record rather than a gap", ""],
    ["Reconciled", "RECONCILED", "Position matched against what the chain says it holds", ""],
    [
      "Settlement",
      run.settlement?.status ?? "PENDING",
      run.settlement?.status === "SETTLED"
        ? `Settled ${run.settlement.outcome} — this ${run.leg} leg ${run.settlement.won ? "paid out" : "expired worthless"}`
        : (run.settlement?.detail ?? "Open, waiting on the contract to expire"),
      // Where the answer came from, and whether our own row has caught up. A
      // stopped deployment stops reconciling, and a page that quietly preferred
      // its own stale copy is how PENDING got asserted after the venue had
      // already answered.
      run.settlement?.source ? `from the ${run.settlement.source}${run.settlement.rivoRecord ? ` · Rivo record: ${run.settlement.rivoRecord}` : ""}` : "",
    ],
  ];

  return (
    <>
      <div className="sec-head">
        <h2>One run, end to end</h2>
        <span className="hint">the most recent confirmed transaction · {network}</span>
      </div>
      <div className="panel">
        <ol className="flow">
          {steps.map(([name, status, detail, extra]) => (
            <li key={name}>
              <span className="n">{name}</span>
              <p style={{ margin: 0 }}>
                <span
                  className="mono"
                  style={{
                    fontSize: 11,
                    letterSpacing: ".08em",
                    color: ["SETTLED", "CONFIRMED", "PASSED", "NORMALISED", "RECORDED", "RECONCILED"].includes(status)
                      ? "var(--pos)"
                      : "var(--warn)",
                  }}
                >
                  {status}
                </span>{" "}
                {name === "Somnia confirmed" ? (
                  <a href={explorer} target="_blank" rel="noreferrer" className="mono" style={{ fontSize: 12.5 }}>
                    {detail}
                  </a>
                ) : (
                  detail
                )}
                {extra && <span className="faint"> · {extra}</span>}
              </p>
            </li>
          ))}
        </ol>
      </div>
    </>
  );
}
