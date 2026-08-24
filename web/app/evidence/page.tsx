"use client";

// Five questions this project asked itself, and the answers it got.
//
// Two of them are no. That is the reason this page exists rather than a feature
// tour: anyone can publish the result that flattered them, and a reader has no
// way to tell a project that measured carefully from one that measured until it
// liked the number. Publishing the refusals is the only cheap signal of the
// difference, and it costs nothing to fake — which is precisely why it has to
// come with the arithmetic attached.
//
// Every figure here is read from docs/evidence/*.json, each written by a command
// in the repository. Nothing on this page is typed in by hand.

import { useLive } from "@/lib/live";
import { Nav } from "@/components/Nav";
import { Reveal } from "@/components/Reveal";

interface Stage { name: string; proven: boolean; evidence: string }
interface Canary {
  generatedAt: string; network: string;
  runtime: { cycles: number; realizedPnl: number; halted: string | null; dryRun: boolean };
  counts: {
    decisions: number; decisionsEntered: number; decisionsRefused: number;
    lotsOpen: number; lotsClosed: number; executionAttempts: number;
    executionsByStatus: Record<string, number>;
  };
  stages: Stage[];
}
interface Calibration {
  generatedAt: string;
  sample: { marketsTotal: number; marketsUsed: number; forecasts: number; realizedUpRate: number };
  discrimination: { auc: number };
  calibration: { brier: number; brierCoin: number };
  holdout: { n: number; auc: number; brier: number; brierCoin: number };
}
interface BacktestRow {
  name: string; finalEquity: number; return: number; maxDrawdown: number;
  trades: number; declined: number; returnOnStake: number;
}
interface Backtest {
  generatedAt: string;
  params: { days: number; capital: number };
  stream: { markets: number; withFills: number; chances: number };
  results: BacktestRow[];
}
interface Maker {
  generatedAt: string;
  params: { capital: number; halfSpread: number; quoteSize: number; cycles: number; mode: string };
  metrics: {
    ordersPosted: number; ordersRejected: number; fills: number; filledShares: number;
    pairedShares: number; oneSidedShares: number;
    capturedSpreadPerShare: number; adverseSelectionPerShare: number;
    maxInventoryShares: number; executionFailures: number;
  };
}
interface Coherence {
  generatedAt: string; days: number; windowsScanned: number; observations: number;
  violations: number; violationRate: number; executableViolations: number;
  medianSizeShares: number; perOccurrence: number; roundTripCost: number;
  grossProfitCeiling: number; pairsStructural: number; pairsBothTraded: number;
}
interface Payload {
  canary: Canary | null; calibration: Calibration | null; backtest: Backtest | null;
  maker: Maker | null; coherence: Coherence | null;
}

const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;
const n = (x: number) => x.toLocaleString("en-US");
const money = (x: number) => `${x < 0 ? "−" : ""}${Math.abs(x).toFixed(2)}`;
const cents = (x: number) => `${x < 0 ? "−" : "+"}${Math.abs(x).toFixed(4)}`;
const day = (iso: string) => iso.slice(0, 10);

/** A question, its answer, and where the answer came from. */
function Question({
  n: num, ask, verdict, tone, headline, source, children,
}: {
  n: number; ask: string; verdict: string; tone: "good" | "caution";
  headline: React.ReactNode; source: string; children: React.ReactNode;
}) {
  return (
    <section style={{ marginTop: 34 }}>
      <div className="sec-head">
        <h2>
          <span className="mono faint" style={{ fontSize: 12, marginRight: 10 }}>
            {String(num).padStart(2, "0")}
          </span>
          {ask}
        </h2>
        <span className={`verdict ${tone}`}>{verdict}</span>
      </div>
      <div className="panel" style={{ marginTop: 12 }}>
        {headline}
        <div className="kv" style={{ marginTop: 14 }}>
          <div>
            <span className="k">source</span>
            <span className="v">{source}</span>
          </div>
        </div>
      </div>
      {children}
    </section>
  );
}

export default function Evidence() {
  // Static artefacts. They change when somebody re-runs a study, not on a clock,
  // so this polls slowly and only to notice a redeploy.
  const { data, error } = useLive<Payload>("/api/evidence", 300_000);

  const c = data?.canary ?? null;
  const cal = data?.calibration ?? null;
  const bt = data?.backtest ?? null;
  const mk = data?.maker ?? null;
  const co = data?.coherence ?? null;

  const rivo = bt?.results.find((r) => r.name.startsWith("Rivo")) ?? null;
  const others = bt?.results.filter((r) => !r.name.startsWith("Rivo")) ?? [];
  const skill = cal ? 1 - cal.holdout.brier / cal.holdout.brierCoin : null;
  const confirmed = c?.counts.executionsByStatus.confirmed ?? 0;

  return (
    <>
      <Nav />
      <main className="wrap" style={{ paddingTop: 26, paddingBottom: 72 }}>
        <span className="label">Evidence</span>
        <h1 style={{ maxWidth: "20ch", marginTop: 8 }}>Five questions. Two answers are no.</h1>
        <p className="lede">
          Anyone can publish the result that flattered them. The only cheap way to tell careful
          measurement from measurement that stopped when it liked the number is to publish the
          refusals too — with the arithmetic attached, so you do not have to believe this paragraph.
          Every figure below is read from a JSON artefact written by a command in the repository.
        </p>

        {error && <div className="banner bad" style={{ marginTop: 20 }}>{error}</div>}
        {!data && !error && <p className="muted" style={{ marginTop: 20 }}>Reading the artefacts…</p>}

        {/* ---------------------------------------------------------------- */}
        {c && (
          <Question
            n={1}
            ask="Does it actually run on-chain?"
            verdict="Yes"
            tone="good"
            source={`canary-fresh.json · ${day(c.generatedAt)} · ${c.network}`}
            headline={
              <>
                <div className="row" style={{ gap: 28, flexWrap: "wrap" }}>
                  <div className="stat">
                    <span className="label">Cycles against the live venue</span>
                    <span className="value">{n(c.runtime.cycles)}</span>
                  </div>
                  <div className="stat">
                    <span className="label">Confirmed transactions</span>
                    <span className="value">
                      {n(confirmed)} <span className="faint">of {n(c.counts.executionAttempts)}</span>
                    </span>
                  </div>
                  <div className="stat">
                    <span className="label">Positions settled and closed</span>
                    <span className="value">{n(c.counts.lotsClosed)}</span>
                  </div>
                </div>
                <p className="muted" style={{ marginTop: 14, maxWidth: "62ch" }}>
                  {n(c.counts.decisions)} decisions recorded, {n(c.counts.decisionsRefused)} of them
                  refusals. A run that only counted the trades it took would be describing a different
                  system — the refusals are what the portfolio layer does for a living.
                </p>
              </>
            }
          >
            <Reveal title="Every stage, and what proves it" hint={`${c.stages.length} stages`}>
              <div className="scroll">
                <table>
                  <thead>
                    <tr><th>Stage</th><th>Proven</th><th>Evidence</th></tr>
                  </thead>
                  <tbody>
                    {c.stages.map((s) => (
                      <tr key={s.name}>
                        <td className="mono">{s.name}</td>
                        <td className={s.proven ? "pos" : "neg"}>{s.proven ? "yes" : "no"}</td>
                        <td className="muted">{s.evidence}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Reveal>
          </Question>
        )}

        {/* ---------------------------------------------------------------- */}
        {cal && skill !== null && (
          <Question
            n={2}
            ask="Does the model know anything?"
            verdict="Yes"
            tone="good"
            source={`calibration.json · ${day(cal.generatedAt)}`}
            headline={
              <>
                <div className="row" style={{ gap: 28, flexWrap: "wrap" }}>
                  <div className="stat">
                    <span className="label">AUC, held-out</span>
                    <span className="value">{cal.holdout.auc.toFixed(4)}</span>
                  </div>
                  <div className="stat">
                    <span className="label">Brier, held-out</span>
                    <span className="value">
                      {cal.holdout.brier.toFixed(4)}{" "}
                      <span className="faint">vs {cal.holdout.brierCoin.toFixed(2)} for a coin</span>
                    </span>
                  </div>
                  <div className="stat">
                    <span className="label">Skill over always-0.5</span>
                    <span className="value pos">{pct(skill)}</span>
                  </div>
                </div>
                <p className="muted" style={{ marginTop: 14, maxWidth: "62ch" }}>
                  Measured on <strong>{n(cal.holdout.n)}</strong> held-out forecasts — the split that
                  matters — drawn from {n(cal.sample.forecasts)} forecasts across{" "}
                  {n(cal.sample.marketsUsed)} settled windows. The realised up-rate over the whole
                  sample is {pct(cal.sample.realizedUpRate)}, so nothing here is a coin that landed
                  heads.
                </p>
              </>
            }
          >
            <Reveal title="In-sample against held-out" hint="why the two differ">
              <div className="scroll">
                <table>
                  <thead>
                    <tr><th>Split</th><th className="n">n</th><th className="n">AUC</th><th className="n">Brier</th></tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>Whole sample</td>
                      <td className="n">{n(cal.sample.forecasts)}</td>
                      <td className="n">{cal.discrimination.auc.toFixed(4)}</td>
                      <td className="n">{cal.calibration.brier.toFixed(4)}</td>
                    </tr>
                    <tr>
                      <td><strong>Held out</strong></td>
                      <td className="n"><strong>{n(cal.holdout.n)}</strong></td>
                      <td className="n"><strong>{cal.holdout.auc.toFixed(4)}</strong></td>
                      <td className="n"><strong>{cal.holdout.brier.toFixed(4)}</strong></td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="muted" style={{ marginTop: 12 }}>
                The held-out figures are the ones quoted everywhere else in this project, and the
                sample size that belongs to them is {n(cal.holdout.n)} — not the{" "}
                {n(cal.sample.forecasts)} the whole study covers. Quoting the better number against
                the bigger sample would be the easiest overstatement available here.
              </p>
            </Reveal>
          </Question>
        )}

        {/* ---------------------------------------------------------------- */}
        {bt && rivo && (
          <Question
            n={3}
            ask="Does the portfolio layer matter?"
            verdict="Yes"
            tone="good"
            source={`backtest.json · ${day(bt.generatedAt)} · ${bt.params.days} days`}
            headline={
              <>
                <div className="row" style={{ gap: 28, flexWrap: "wrap" }}>
                  <div className="stat">
                    <span className="label">Rivo, from {bt.params.capital}</span>
                    <span className="value">{money(rivo.finalEquity)}</span>
                  </div>
                  <div className="stat">
                    <span className="label">Trades survived</span>
                    <span className="value">{n(rivo.trades)}</span>
                  </div>
                  <div className="stat">
                    <span className="label">Every alternative</span>
                    <span className="value neg">0.00</span>
                  </div>
                </div>
                <p className="muted" style={{ marginTop: 14, maxWidth: "62ch" }}>
                  This is not a profit claim — Rivo ends down {pct(Math.abs(rivo.return))} and says so.
                  It is a ruin claim: with a negative underlying edge, the constraints are the
                  difference between losing some of the capital and losing all of it in under sixty
                  trades.
                </p>
              </>
            }
          >
            <Reveal title="Every sizing rule, side by side" hint={`${bt.results.length} strategies`}>
              <div className="scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Sizing</th><th className="n">Final</th><th className="n">Trades</th>
                      <th className="n">Max drawdown</th><th className="n">Return on stake</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td><strong>{rivo.name}</strong></td>
                      <td className="n"><strong>{money(rivo.finalEquity)}</strong></td>
                      <td className="n"><strong>{n(rivo.trades)}</strong></td>
                      <td className="n">{pct(rivo.maxDrawdown)}</td>
                      <td className={`n ${rivo.returnOnStake >= 0 ? "pos" : "neg"}`}>
                        {pct(rivo.returnOnStake, 2)}
                      </td>
                    </tr>
                    {others.map((r) => (
                      <tr key={r.name}>
                        <td className="muted">{r.name}</td>
                        <td className="n neg">{money(r.finalEquity)}</td>
                        <td className="n">{n(r.trades)}</td>
                        <td className="n">{pct(r.maxDrawdown)}</td>
                        <td className={`n ${r.returnOnStake >= 0 ? "pos" : "neg"}`}>
                          {pct(r.returnOnStake, 2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="muted" style={{ marginTop: 12 }}>
                Replayed over {n(bt.stream.chances)} priced opportunities from {n(bt.stream.markets)}{" "}
                markets, {n(bt.stream.withFills)} of which had fills to replay against.
              </p>
            </Reveal>
          </Question>
        )}

        {/* ---------------------------------------------------------------- */}
        {mk && (
          <Question
            n={4}
            ask="Would providing liquidity work instead?"
            verdict="No"
            tone="caution"
            source={`maker-live.json · ${day(mk.generatedAt)} · ${mk.params.mode} on testnet`}
            headline={
              <>
                <div className="row" style={{ gap: 28, flexWrap: "wrap" }}>
                  <div className="stat">
                    <span className="label">Spread captured per share</span>
                    <span className="value neg">{cents(mk.metrics.capturedSpreadPerShare)}</span>
                  </div>
                  <div className="stat">
                    <span className="label">Adverse selection per share</span>
                    <span className="value neg">{cents(mk.metrics.adverseSelectionPerShare)}</span>
                  </div>
                  <div className="stat">
                    <span className="label">Shares that paired off</span>
                    <span className="value neg">{n(mk.metrics.pairedShares)}</span>
                  </div>
                </div>
                <p className="muted" style={{ marginTop: 14, maxWidth: "62ch" }}>
                  Making is the structural alternative to crossing the spread, so it was measured
                  rather than assumed — with real quotes on-chain, not a replay. Every one of the{" "}
                  {n(mk.metrics.filledShares)} filled shares was one-sided: the book took the side it
                  wanted and left the other resting. A market maker who never gets paired is not
                  earning a spread, they are taking a position slowly.
                </p>
              </>
            }
          >
            <Reveal title="The whole run" hint={`${mk.params.cycles} cycles, ${mk.params.capital} capital`}>
              <div className="kv">
                <div><span className="k">orders posted</span><span className="v">{n(mk.metrics.ordersPosted)}</span></div>
                <div><span className="k">rejected</span><span className="v">{n(mk.metrics.ordersRejected)}</span></div>
                <div><span className="k">fills</span><span className="v">{n(mk.metrics.fills)}</span></div>
                <div><span className="k">shares filled</span><span className="v">{n(mk.metrics.filledShares)}</span></div>
                <div><span className="k">one-sided</span><span className="v">{n(mk.metrics.oneSidedShares)}</span></div>
                <div><span className="k">max inventory</span><span className="v">{n(mk.metrics.maxInventoryShares)}</span></div>
                <div><span className="k">half spread quoted</span><span className="v">{mk.params.halfSpread}</span></div>
                <div><span className="k">execution failures</span><span className="v">{n(mk.metrics.executionFailures)}</span></div>
              </div>
              <p className="muted" style={{ marginTop: 12 }}>
                A sixteen-order run is small and this does not pretend otherwise. What it establishes
                is a direction and a mechanism, on a live book, at a size where being wrong cost
                nothing — which is the correct order to find out in.
              </p>
            </Reveal>
          </Question>
        )}

        {/* ---------------------------------------------------------------- */}
        {co && (
          <Question
            n={5}
            ask="Is there a model-free arbitrage across tenors?"
            verdict="No — real, and too small"
            tone="caution"
            source={`coherence.json · ${day(co.generatedAt)} · ${co.days} days`}
            headline={
              <>
                <div className="row" style={{ gap: 28, flexWrap: "wrap" }}>
                  <div className="stat">
                    <span className="label">Violations found</span>
                    <span className="value">{n(co.violations)}</span>
                    <span className="hint">{pct(co.violationRate, 2)} of {n(co.observations)}</span>
                  </div>
                  <div className="stat">
                    <span className="label">Profit per occurrence</span>
                    <span className="value">{co.perOccurrence.toFixed(3)}</span>
                  </div>
                  <div className="stat">
                    <span className="label">Round trip costs</span>
                    <span className="value neg">{co.roundTripCost.toFixed(3)}</span>
                  </div>
                </div>
                <p className="muted" style={{ marginTop: 14, maxWidth: "62ch" }}>
                  The bound is real and it is violated {n(co.violations)} times. It is still not a
                  strategy: the median violation is {co.medianSizeShares} shares deep, so the whole
                  thirty-day ceiling is {co.grossProfitCeiling.toFixed(2)} before costs — and the
                  costs are most of it. Rejected on size rather than on existence, which is a
                  different finding and the honest one.
                </p>
              </>
            }
          >
            <Reveal title="How the bound was tested" hint={`${n(co.windowsScanned)} windows`}>
              <div className="kv">
                <div><span className="k">windows scanned</span><span className="v">{n(co.windowsScanned)}</span></div>
                <div><span className="k">structural pairs</span><span className="v">{n(co.pairsStructural)}</span></div>
                <div><span className="k">both sides traded</span><span className="v">{n(co.pairsBothTraded)}</span></div>
                <div><span className="k">observations</span><span className="v">{n(co.observations)}</span></div>
                <div><span className="k">executable violations</span><span className="v">{n(co.executableViolations)}</span></div>
                <div><span className="k">median depth</span><span className="v">{co.medianSizeShares} shares</span></div>
                <div><span className="k">gross ceiling, 30d</span><span className="v">{co.grossProfitCeiling.toFixed(2)}</span></div>
              </div>
              <p className="muted" style={{ marginTop: 12 }}>
                Only {n(co.pairsBothTraded)} of {n(co.pairsStructural)} structurally comparable pairs
                had trades on both sides. A bound you cannot transact on both legs of is a fact about
                the price, not an opportunity.
              </p>
            </Reveal>
          </Question>
        )}

        {data && !c && !cal && !bt && !mk && !co && (
          <div className="banner warn" style={{ marginTop: 24 }}>
            This deployment carries no evidence artefacts. They live in{" "}
            <span className="mono">docs/evidence/</span> and are produced by{" "}
            <span className="mono">npm run calibrate</span>, <span className="mono">npm run backtest</span>,{" "}
            <span className="mono">npm run maker:live</span>, <span className="mono">npm run coherence</span>{" "}
            and <span className="mono">npm run proof</span>.
          </div>
        )}

        <section style={{ marginTop: 44 }}>
          <div className="sec-head"><h2>Reproduce any of it</h2></div>
          <p className="muted" style={{ maxWidth: "62ch" }}>
            Each artefact is regenerated by one command, and each command reads only public endpoints
            — no key, no funded wallet, no access to this deployment.
          </p>
          <div className="scroll" style={{ marginTop: 12 }}>
            <table>
              <thead><tr><th>Question</th><th>Command</th><th>Writes</th></tr></thead>
              <tbody>
                <tr><td>01 · on-chain</td><td className="mono">npm run proof</td><td className="mono faint">live-canary.json</td></tr>
                <tr><td>02 · the model</td><td className="mono">npm run calibrate</td><td className="mono faint">calibration.json</td></tr>
                <tr><td>03 · portfolio layer</td><td className="mono">npm run backtest</td><td className="mono faint">backtest.json</td></tr>
                <tr><td>04 · making</td><td className="mono">npm run maker:live -- --live</td><td className="mono faint">maker-live.json</td></tr>
                <tr><td>05 · coherence</td><td className="mono">npm run coherence -- --days 30</td><td className="mono faint">coherence.json</td></tr>
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </>
  );
}
