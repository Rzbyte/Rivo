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

import { useEffect, useState } from "react";
import { Nav } from "@/components/Nav";

interface Agent {
  slug: string; label: string; kind: string; hasEndpoint: boolean;
  state: "UNVALIDATED" | "SHADOW_ONLY" | "VALIDATED" | "REJECTED";
  evidence: string | null;
  summary: { auc?: number; returnOnStake?: number; tStat?: number; note?: string };
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
  const [data, setData] = useState<Payload | null>(null);
  useEffect(() => {
    fetch("/api/agents").then((r) => r.json()).then(setData).catch(() => undefined);
  }, []);

  const rivo = data?.agents.find((a) => a.slug === "rivo-v1") ?? null;
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
            <div className="sec-head">
              <h2>Fold by fold</h2>
              <span className="hint">walk-forward · never a random split</span>
            </div>
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

            <div className="sec-head">
              <h2>Does a bigger claimed edge pay better?</h2>
              <span className="hint">the diagnostic that decided this</span>
            </div>
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

            {production.gate && production.gate.failures.length > 0 && (
              <>
                <div className="sec-head">
                  <h2>Why the gate refused it</h2>
                </div>
                <div className="panel">
                  <ul style={{ margin: 0, paddingLeft: 18, color: "var(--muted)", fontSize: 13.5 }}>
                    {production.gate.failures.map((f) => <li key={f} style={{ marginBottom: 6 }}>{f}</li>)}
                  </ul>
                </div>
              </>
            )}
          </>
        )}

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
          <p className="hint" style={{ marginTop: 12, marginBottom: 0 }}>
            Every decision runs in Live Shadow first. No agent reaches a testnet transaction without
            passing the same gate Rivo V1 failed.
          </p>
        </div>
      </main>
    </>
  );
}
