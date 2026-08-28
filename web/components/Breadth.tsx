"use client";

// One strategy failing is a fact about that strategy.
//
// The Agents page used to answer "does the model deserve capital?" with a sample
// of one — Rivo's own, REJECTED. That is the strongest finding in the project and
// it is still one data point, and a reader arriving at this venue has the wider
// question: does ANYTHING simple work here?
//
// So six baselines run against the same live contracts, and this renders what
// came back. Each one carries the hypothesis it is on the board to test, because
// six rows reading UNVALIDATED with no explanation is clutter, not a study — and
// that is exactly what this page showed for the hours between the agents being
// registered and this component existing.
//
// IT IS NOT A LEADERBOARD. judge-faq.md §2 refuses ranking, prizes and a social
// layer; DreamDEX runs Algo Arena for competition and it is scored on volume,
// over spot pairs Event Contracts are not eligible for. Rows are in registration
// order, there is no rank column, and `coin-flip` sits among them as the null
// hypothesis rather than as a joke.

import { useLive } from "@/lib/live";
import { Reveal } from "@/components/Reveal";

interface Strategy {
  slug: string; label: string; kind: string; state: string;
  question: string | null; isBaseline: boolean;
  asked: number; settled: number; entered: number; windows: number;
  returnOnStake: number | null; hitRate: number | null;
  lo95: number | null; hi95: number | null; thin: boolean;
  verdict: "CLEARS_THE_SPREAD" | "LOSES" | "INCONCLUSIVE" | null;
}
interface Payload {
  strategies: Strategy[];
  method?: { minWindows?: number };
  error?: string;
}

const pct = (v: number | null, d = 2) => (v === null ? "—" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%`);

const VERDICT_TONE: Record<string, string> = {
  CLEARS_THE_SPREAD: "pos", LOSES: "neg", INCONCLUSIVE: "warn",
};
const VERDICT_LABEL: Record<string, string> = {
  CLEARS_THE_SPREAD: "CLEARS THE SPREAD", LOSES: "LOSES", INCONCLUSIVE: "INCONCLUSIVE",
};

export function Breadth() {
  const { data } = useLive<Payload>("/api/breadth", 30_000);

  const baselines = data?.strategies.filter((s) => s.isBaseline) ?? [];
  if (!data || baselines.length === 0) return null;

  const minWindows = data.method?.minWindows ?? 200;
  const settledAny = baselines.some((s) => s.windows > 0);
  const concluded = baselines.filter((s) => s.verdict !== null);

  return (
    <>
      <div className="sec-head">
        <h2>Does anything simple work here?</h2>
        <span className="hint">{baselines.length} strategies, decided live, never sent</span>
      </div>

      <div className="panel">
        <p style={{ maxWidth: "72ch", marginTop: 0 }}>
          Rivo&rsquo;s own model is one strategy, and one strategy failing is a fact about that
          strategy. These six are rules somebody would try in their first hour — each testing a
          different idea about where an edge might be, each deciding against the same live Event
          Contracts, each resolved against the venue&rsquo;s own settlement.{" "}
          <strong>Every number below is hypothetical.</strong> None of them can spend: they are
          UNVALIDATED, they hold no key, and the pre-execution pipeline is the only route to a signer.
        </p>

        {!settledAny ? (
          // The honest empty state. "No data" and "no result" are different
          // claims, and a table of dashes reads as the second.
          <p className="muted" style={{ maxWidth: "72ch" }}>
            They are running now, and nothing has settled yet — the contracts they have decided on are
            still open. Each row needs {minWindows} settled contracts before it is allowed to conclude
            anything, and 15-minute windows settle every 15 minutes.
          </p>
        ) : (
          <p className="muted" style={{ maxWidth: "72ch" }}>
            {concluded.length === 0
              ? `None has reached ${minWindows} settled contracts yet, so none is allowed to conclude anything. The intervals below are what the sample supports so far.`
              : `${concluded.length} of ${baselines.length} has reached ${minWindows} settled contracts and is entitled to a verdict.`}
          </p>
        )}

        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Strategy</th>
                <th className="hide-sm">The question it tests</th>
                <th>Windows</th>
                <th>Return on stake</th>
                <th className="hide-sm">95% interval</th>
                <th>Verdict</th>
              </tr>
            </thead>
            <tbody>
              {baselines.map((s) => (
                <tr key={s.slug}>
                  <td>
                    <strong>{s.label}</strong>
                    <div className="faint mono" style={{ fontSize: 11.5 }}>{s.slug}</div>
                  </td>
                  <td className="hide-sm faint" style={{ fontSize: 12.5, maxWidth: "34ch" }}>
                    {s.question ?? "—"}
                  </td>
                  {/* Sample size before the return, deliberately. A return with
                      no n beside it is the number people quote. */}
                  <td className="num">
                    {s.windows}
                    {s.windows > 0 && s.thin && <span className="faint"> / {minWindows}</span>}
                  </td>
                  <td className={`num ${s.thin || s.returnOnStake === null ? "faint" : s.returnOnStake >= 0 ? "pos" : "neg"}`}>
                    {pct(s.returnOnStake)}
                  </td>
                  <td className="num hide-sm faint" style={{ fontSize: 12.5 }}>
                    {s.lo95 === null ? "—" : `${pct(s.lo95, 1)} … ${pct(s.hi95, 1)}`}
                  </td>
                  <td className={s.verdict ? VERDICT_TONE[s.verdict] : "faint"} style={{ fontSize: 12.5 }}>
                    {s.verdict
                      ? VERDICT_LABEL[s.verdict]
                      : s.windows === 0
                        ? "nothing settled"
                        : "too few to say"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <Reveal title="How this is measured" hint="why the unit is the contract, not the decision">
          <div style={{ color: "var(--muted)", fontSize: 13.5, maxWidth: "74ch" }}>
            <p style={{ marginTop: 0 }}>
              <strong>The unit is the settled contract, not the decision.</strong> Forty decisions
              inside one Event Contract share one outcome, so counting them as forty observations
              shrinks every interval and reports a precision nobody has. The return pools decisions;
              the interval is bootstrapped over contracts.
            </p>
            <p>
              Return on stake is <span className="mono">sum(pnl) / sum(entry &times; size)</span> over
              settled decisions that were actually sized. A strategy that declined to size is counted
              as asked, and kept out of the return entirely.
            </p>
            <p>
              A verdict needs <strong>{minWindows} settled contracts</strong>, matching the acceptance
              gate in <span className="mono">src/research/gating.ts</span>. Below that a row publishes
              its interval and says <em>too few to say</em> — even when the bound looks decisive,
              because sample size outranks a clean-looking interval.
            </p>
            <p style={{ marginBottom: 0 }}>
              Every baseline is reached over its own public HTTP endpoint — the same vetting, timeout,
              clamping and pre-execution path a stranger&rsquo;s agent travels. Their rules are in{" "}
              <span className="mono">src/intel/baselines.ts</span>, and each endpoint serves its own
              rule on <span className="mono">GET</span>.
            </p>
          </div>
        </Reveal>
      </div>
    </>
  );
}
