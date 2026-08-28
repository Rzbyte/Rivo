"use client";

// Does the model deserve capital?
//
// The page exists because of one finding this project made about itself: a
// forecast can be good and the trade built on it can still lose. Rivo V1 is the
// case study, and it is presented as REJECTED because that is what its own
// out-of-sample evidence says.
//
// Both numbers are shown together, always. Accuracy alone implies a
// profitability the evidence does not support; the verdict alone hides that the
// model is genuinely good at what it was built for.

import { useLive, ago } from "@/lib/live";
import { Nav } from "@/components/Nav";
import { ConnectAgent } from "@/components/ConnectAgent";
import { TryAgent } from "@/components/TryAgent";
import { Reveal } from "@/components/Reveal";
import { Breadth } from "@/components/Breadth";

interface Agent {
  slug: string; label: string; kind: string; hasEndpoint: boolean;
  state: "UNVALIDATED" | "SHADOW_ONLY" | "VALIDATED" | "REJECTED";
  evidence: string | null;
  summary: {
    auc?: number; returnOnStake?: number; tStat?: number; note?: string;
    /** Set on Rivo's own reference strategies. They have their own section. */
    baseline?: boolean; question?: string;
  };
}
interface Fold { fold: number; all: { returnOnStake: number; windows: number; trades: number } }
interface Result {
  strategy: string;
  all: { returnOnStake: number; tStat: number; windows: number; trades: number; stake: number; pnl: number; maxDrawdown: number; winRate: number };
  byFold: Fold[];
  edgeBuckets: { lo: number; hi: number; trades: number; meanEdge: number; returnOnStake: number }[];
  gate: { state: string; failures: string[] } | null;
}
interface Payload { agents: Agent[]; research: { results: Result[]; dataset: { windows: number; rows: number } } | null }

const pct = (x: number, d = 2) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(d)}%`;

const STATE_TONE: Record<Agent["state"], string> = {
  VALIDATED: "pos", REJECTED: "neg", SHADOW_ONLY: "warn", UNVALIDATED: "faint",
};

export default function Agents() {
  // The registry changes when somebody connects an agent, and a verdict changes
  // when a validation run finishes. Neither is fast, so neither needs to be.
  const { data } = useLive<Payload>("/api/agents", 30_000);

  const rivo = data?.agents.find((a) => a.slug === "rivo-v1") ?? null;
  // Everything that is neither Rivo's own model nor one of its baselines: an
  // agent a stranger connected. Each of the three has its own section, because
  // one table holding all of them would assert they are the same kind of thing.
  const connected = data?.agents.filter((a) => a.slug !== "rivo-v1" && a.summary?.baseline !== true) ?? [];
  const production = data?.research?.results.find((r) => r.strategy.includes("0.03")) ?? null;

  return (
    <>
      <Nav />
      <main className="wrap" style={{ paddingTop: 26, paddingBottom: 72 }}>
        <span className="label">Agents</span>
        <h1 style={{ maxWidth: "20ch", marginTop: 8 }}>A model can predict well and still trade badly.</h1>
        <p className="lede">
          Forecast quality and economic quality are different measurements, and only one of them decides
          whether an agent may spend. Rivo tests the second before anything is deployed — starting with its
          own model, which failed.
        </p>

        {!data && <p className="muted" style={{ marginTop: 20 }}>Loading…</p>}

        {rivo && (
          <>
            <div className="sec-head">
              <h2>{rivo.label}</h2>
              <span className="hint">{rivo.evidence ?? "no evidence recorded"}</span>
            </div>

            <section className="grid cols-3">
              <div className="panel stat">
                <span className="label">Forecast quality</span>
                <span className="value">AUC {rivo.summary.auc?.toFixed(4) ?? "—"}</span>
                <span className="sub">How well it separates up from down. Measured, and good.</span>
              </div>
              <div className="panel stat">
                <span className="label">Economic quality</span>
                <span className="value neg">{rivo.summary.returnOnStake !== undefined ? pct(rivo.summary.returnOnStake) : "—"}</span>
                <span className="sub">Return on stake, out of sample, walk-forward.</span>
              </div>
              <div className="panel stat">
                <span className="label">Verdict</span>
                <span className={`value ${STATE_TONE[rivo.state]}`}>{rivo.state}</span>
                <span className="sub">Read by the execution gate, not just displayed.</span>
              </div>
            </section>

            {rivo.summary.note && (
              <div className="banner warn" style={{ marginTop: 12 }}>
                <strong>Execution eligibility: Experimental Testnet only.</strong> {rivo.summary.note}
              </div>
            )}
          </>
        )}

        {production && (
          <>
            <Reveal title="Fold by fold" hint="walk-forward · never a random split">
              <div className="panel">
              <div className="scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Fold</th>
                      <th className="n">Settled windows</th>
                      <th className="n">Trades</th>
                      <th className="n">Return on stake</th>
                    </tr>
                  </thead>
                  <tbody>
                    {production.byFold.map((f) => (
                      <tr key={f.fold}>
                        <td className="mono">{f.fold}</td>
                        <td className="n">{f.all.windows}</td>
                        <td className="n">{f.all.trades}</td>
                        <td className={`n ${f.all.returnOnStake >= 0 ? "pos" : "neg"}`}>{pct(f.all.returnOnStake)}</td>
                      </tr>
                    ))}
                    <tr>
                      <td className="mono"><strong>all</strong></td>
                      <td className="n">{production.all.windows}</td>
                      <td className="n">{production.all.trades}</td>
                      <td className={`n ${production.all.returnOnStake >= 0 ? "pos" : "neg"}`}>
                        <strong>{pct(production.all.returnOnStake)}</strong>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="hint" style={{ marginTop: 12, marginBottom: 0 }}>
                t = {production.all.tStat.toFixed(2)} on a bootstrap that resamples settled windows ·
                max drawdown {production.all.maxDrawdown.toFixed(2)} · hit rate {(production.all.winRate * 100).toFixed(1)}%
              </p>
              </div>
            </Reveal>

            <Reveal title="Claimed edge against realised" hint="the diagnostic that decided this">
              <div className="panel">
              <div className="scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Claimed edge</th>
                      <th className="n">Trades</th>
                      <th className="n">Mean claimed</th>
                      <th className="n">Realised</th>
                    </tr>
                  </thead>
                  <tbody>
                    {production.edgeBuckets.map((b) => (
                      <tr key={b.lo}>
                        <td className="mono">{b.lo.toFixed(3)}–{b.hi === 1 ? "∞" : b.hi.toFixed(3)}</td>
                        <td className="n">{b.trades}</td>
                        <td className="n">{pct(b.meanEdge, 2)}</td>
                        <td className={`n ${b.returnOnStake >= 0 ? "pos" : "neg"}`}>{pct(b.returnOnStake)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="hint" style={{ marginTop: 12, marginBottom: 0 }}>
                There is no monotone relationship. Claiming more edge did not earn more, which is what
                separates a forecast that is right from a trade that is profitable.
              </p>
              </div>
            </Reveal>

            {production.gate && production.gate.failures.length > 0 && (
              <Reveal title="Why the gate refused it" hint={`${production.gate.failures.length} criteria not met`}>
                <ul style={{ margin: 0, paddingLeft: 18, color: "var(--muted)", fontSize: 13.5 }}>
                  {production.gate.failures.map((f) => <li key={f} style={{ marginBottom: 6 }}>{f}</li>)}
                </ul>
              </Reveal>
            )}
          </>
        )}

        <Breadth />

        {/* Agents somebody else connected. Rivo's own model has the section
            above it and the six baselines have their own, so listing all three
            groups in one table would put a stranger's endpoint beside a
            reference strategy and call them the same kind of thing. */}
        {connected.length > 0 && (
          <>
            <Reveal title="Connected agents" hint={`${connected.length} connected by somebody else`}>
              <div className="panel">
              <div className="scroll">
                <table>
                  <thead>
                    <tr><th>Agent</th><th className="hide-sm">Kind</th><th>State</th><th className="hide-sm">Evidence</th></tr>
                  </thead>
                  <tbody>
                    {connected.map((a) => (
                      <tr key={a.slug}>
                        <td><strong>{a.label}</strong></td>
                        <td className="mono hide-sm">{a.kind}{a.kind === "http" && a.hasEndpoint ? " · endpoint set" : ""}</td>
                        <td className={STATE_TONE[a.state]}>{a.state}</td>
                        <td className="faint hide-sm" style={{ fontSize: 12.5 }}>{a.evidence ?? "not yet validated"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              </div>
            </Reveal>
          </>
        )}

        <LiveShadow />

        <div className="sec-head">
          <h2>Connect another agent</h2>
          <span className="hint">HTTP, typed, no uploaded code</span>
        </div>
        <div className="panel">
          <p style={{ maxWidth: "70ch" }}>
            Rivo asks your endpoint what it thinks about one Event Contract and keeps everything
            dangerous on its own side — validation, risk limits, the wallet, the ledger, reconciliation
            and settlement. Your agent never holds a key and never submits a transaction.
          </p>

          {/* The trial comes FIRST. Registering is the commitment; trying is
              the thing that earns it, and putting the commitment first is how
              the capability ended up invisible to everyone without an account. */}
          <div className="sec-head" style={{ marginTop: 30 }}>
            <h2>Try your agent now</h2>
            <span className="hint">one live window · no account · nothing stored</span>
          </div>
          <TryAgent />

          {/* Behind a disclosure, and that is the right order rather than a
              space saving. Trying is what earns the commitment; putting the
              registration form open on the page is what made the capability
              look like paperwork to everybody who had not tried it yet. */}
          <Reveal
            title="Connect it for real"
            hint="runs against every live window, and resolves against real settlements"
          >
            <ConnectAgent onConnected={() => location.reload()} />
          </Reveal>

          <div style={{ marginTop: 16 }}>
          <Reveal title="The contract" hint="what Rivo POSTs, and what it expects back">
          <pre className="mono" style={{ fontSize: 12, overflowX: "auto", background: "var(--panel-2)", padding: 12, borderRadius: "var(--r)", margin: 0 }}>
{`POST  your-endpoint
{
  "market":     { "asset": "BTC", "leg": "UP", "intervalSec": 900,
                  "marketId": "0x…", "expiry": 1787512502 },
  "price":      { "bid": 0.62, "ask": 0.64, "depth": 40 },
  "reference":  { "spot": 64210.5, "probability": 0.61 },
  "limits":     { "maxNotional": 5.0 }
}

200
{
  "action":     "ENTER" | "SKIP",
  "probability": 0.66,          // what you think it is
  "confidence":  0.4,           // 0..1, optional
  "notional":    2.5,           // never above limits.maxNotional
  "reason":      "short text"
}`}
          </pre>
          </Reveal>
          </div>
          <p className="hint" style={{ marginTop: 12, marginBottom: 0 }}>
            Every decision runs in Live Shadow first. No agent reaches a testnet transaction without
            passing the same gate Rivo V1 failed.
          </p>
        </div>
      </main>
    </>
  );
}

interface ShadowRow {
  agent: { slug: string; label: string; state: string };
  asset: string; leg: string; intervalSec: number;
  decidedAt: string; expiry: string;
  marketPrice: number; agentPrice: number | null; confidence: number | null;
  action: string; reason: string | null;
  hypotheticalSize: number | null; hypotheticalEntry: number | null;
  settledAt: string | null; outcome: number | null; hypotheticalPnl: number | null;
  runId: string | null; runMode: string | null;
  intent: { outcome: string; stage: string | null; code: string | null; normalizedSize: number | null } | null;
}
interface ShadowPayload {
  decisions: ShadowRow[];
  summary: { total: number; entered: number; settled: number; hypotheticalPnl: number | null; hitRate: number | null } | null;
  intents?: { outcome: string; code: string | null; n: number }[];
  heartbeat?: { lastDecisionAt: string | null; lastWorkerBeatAt: string | null; liveWorkers: number };
}

/**
 * "42s ago", from a timestamp the server sent.
 *
 * Recomputed on every render rather than stored, so a tab left open does not
 * quietly display an age that stopped counting.
 */
function sinceText(iso: string): string {
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

/**
 * What the agent WOULD have done.
 *
 * Visually separated from anything that moved money, and labelled HYPOTHETICAL
 * on every row that has not settled. The failure this guards against is not a
 * bug — it is somebody quoting these numbers as a result.
 */
function LiveShadow() {
  const { data: d, updatedAt } = useLive<ShadowPayload>("/api/shadow?limit=40", 10_000);
  if (!d || !d.summary) return null;
  const s = d.summary;

  return (
    <>
      <div className="sec-head">
        <h2>Live Shadow</h2>
        <span className="hint">deciding against live markets · no capital can move · {ago(updatedAt)}</span>
      </div>

      {/* Proof of life, before any count.
          "Autonomous" is a claim, and a page of totals cannot distinguish a
          worker deciding right now from one that stopped days ago leaving its
          numbers behind. */}
      {d.heartbeat && (
        <div className="kv" style={{ marginBottom: 12 }}>
          <div>
            <span className="k">Runtime</span>
            <span className={`v ${d.heartbeat.liveWorkers > 0 ? "pos" : "neg"}`}>
              {d.heartbeat.liveWorkers > 0 ? "RUNNING" : "NO LIVE WORKER"}
            </span>
          </div>
          <div>
            <span className="k">Workers</span>
            <span className="v">{d.heartbeat.liveWorkers}</span>
          </div>
          <div>
            <span className="k">Last heartbeat</span>
            <span className="v">
              {d.heartbeat.lastWorkerBeatAt ? sinceText(d.heartbeat.lastWorkerBeatAt) : "never"}
            </span>
          </div>
          <div>
            <span className="k">Last decision</span>
            <span className="v">
              {d.heartbeat.lastDecisionAt ? sinceText(d.heartbeat.lastDecisionAt) : "none yet"}
            </span>
          </div>
        </div>
      )}

      <div className="banner" style={{ marginBottom: 12 }}>
        <strong>Every number below is hypothetical.</strong> These decisions ran against real DreamDEX
        Event Contracts at real prices, and no transaction was sent for any of them. When a contract
        settles, the same outcome that closes a real position resolves the row.
      </div>

      <section className="grid cols-4" style={{ marginBottom: 12 }}>
        <div className="panel stat">
          <span className="label">Decisions</span>
          <span className="value">{s.total.toLocaleString()}</span>
          <span className="sub">{s.entered} would have entered.</span>
        </div>
        <div className="panel stat">
          <span className="label">Settled</span>
          <span className="value">{s.settled.toLocaleString()}</span>
          <span className="sub">Resolved against the venue&rsquo;s own outcome.</span>
        </div>
        <div className="panel stat">
          <span className="label">Hypothetical P&amp;L</span>
          <span className={`value ${(s.hypotheticalPnl ?? 0) >= 0 ? "pos" : "neg"}`}>
            {s.hypotheticalPnl === null ? "—" : s.hypotheticalPnl.toFixed(2)}
          </span>
          <span className="sub">Not a result. Nothing was staked.</span>
        </div>
        <div className="panel stat">
          <span className="label">Hit rate</span>
          <span className="value">{s.hitRate === null ? "—" : `${(s.hitRate * 100).toFixed(0)}%`}</span>
          <span className="sub">Of settled entries only.</span>
        </div>
      </section>

      {/* What the shared pipeline did with them.
          The number that says shadow is running the same checks as the real
          path rather than writing down whatever an agent said: if every
          decision were EXECUTE, none of the constraints would be binding. */}
      {d.intents && d.intents.length > 0 && (
        <Reveal
          title="What the pre-execution pipeline decided"
          hint="the same checks the real path runs, before any signer"
        >
          <div className="panel">
            <div className="scroll">
              <table>
                <thead>
                  <tr><th>Outcome</th><th>Why</th><th className="n">Decisions</th></tr>
                </thead>
                <tbody>
                  {d.intents.map((i) => (
                    <tr key={`${i.outcome}-${i.code ?? "none"}`}>
                      <td>
                        <span className={`verdict ${i.outcome === "EXECUTE" ? "good" : i.outcome === "REFUSED" ? "caution" : ""}`}>
                          {i.outcome === "EXECUTE" ? "HYPOTHETICAL" : i.outcome}
                        </span>
                      </td>
                      <td className="mono" style={{ fontSize: 12 }}>{i.code ?? "—"}</td>
                      <td className="n">{i.n.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="hint" style={{ marginTop: 10, marginBottom: 0 }}>
              EXECUTE means every check passed and a real deployment would have sent an order. Here it
              means a hypothetical position and nothing else — no signer is reachable from this path.
            </p>
          </div>
        </Reveal>
      )}

      <Reveal title="Recent decisions" hint={`${d.decisions.length} shown · every one hypothetical`}>
      <div className="panel">
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Market</th><th className="n">Venue</th><th className="n">Agent</th>
                <th>Decision</th><th className="hide-sm">Status</th><th className="n">Hypothetical</th>
              </tr>
            </thead>
            <tbody>
              {d.decisions.map((r, i) => (
                <tr key={`${r.decidedAt}-${i}`}>
                  <td className="mono">{r.asset} {r.leg} · {Math.round(r.intervalSec / 60)}m</td>
                  <td className="n">{(r.marketPrice * 100).toFixed(1)}%</td>
                  <td className="n">{r.agentPrice === null ? "—" : `${(r.agentPrice * 100).toFixed(1)}%`}</td>
                  <td>
                    <strong className={r.action === "ENTER" ? "pos" : ""}>{r.action}</strong>
                    {r.reason && <span className="faint hide-sm" style={{ fontSize: 12 }}> — {r.reason}</span>}
                  </td>
                  <td className="mono hide-sm" style={{ fontSize: 11.5 }}>
                    {r.settledAt ? (
                      <span className={r.outcome === 1 ? "pos" : "neg"}>SETTLED {r.outcome === 1 ? "TRUE" : "FALSE"}</span>
                    ) : (
                      <span className="faint">HYPOTHETICAL</span>
                    )}
                  </td>
                  <td className="n">
                    {r.hypotheticalPnl !== null ? (
                      <span className={r.hypotheticalPnl >= 0 ? "pos" : "neg"}>{r.hypotheticalPnl.toFixed(2)}</span>
                    ) : r.hypotheticalSize !== null ? (
                      <span className="faint">{r.hypotheticalSize.toFixed(2)} @ {r.hypotheticalEntry?.toFixed(3)}</span>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      </Reveal>
    </>
  );
}
