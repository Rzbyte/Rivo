// The landing page.
//
// It has one job and it is not to ask for a wallet. Somebody arriving has no
// idea whether a DreamDEX probability means anything, and the fastest way to
// lose them is to answer that with a Connect button.
//
// The previous version opened on "Set a budget and a risk profile once" — a
// consumer fund-manager pitch for a product whose own research says its strategy
// should not receive capital. Those two things cannot both be on the same site.
//
// The version after that opened on the rejection: "Rivo found this out about
// itself… so Rivo V1 is marked REJECTED". True, and the strongest thing in the
// project, and the wrong first paragraph — it asked a reader to work out why a
// tool that refuses to trade is worth their time, in the ten seconds before they
// close the tab. The finding is not softened here, it is MOVED: what Rivo is for
// comes first, and the self-rejection follows as the evidence that the apparatus
// is real. A validator that never rejects anything is a rubber stamp.
//
// The numbers are imported rather than typed. They were string literals, on the
// one page that reads no data, so nothing could have caught them drifting from
// the verdict /agents shows — and `landing.test.ts` now fails if they come back.

import Link from "next/link";
import { Nav } from "@/components/Nav";
import { PRODUCTION_STRATEGY } from "@rivo/research/gating.js";
import { BASELINES } from "@rivo/intel/baselines.js";

const pct = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(2)}%`;

export default function Landing() {
  return (
    <>
      <Nav />
      <main className="wrap" style={{ paddingTop: 40, paddingBottom: 72 }}>
        <span className="label">DreamDEX Event Contracts · Somnia</span>
        <h1 style={{ maxWidth: "18ch", marginTop: 10 }}>
          Event Contracts you can check before you trade them.
        </h1>
        <p className="lede">
          A price on a binary contract is a forecast, and a forecast nobody has scored is an opinion
          with a number on it. Rivo scores them — against contracts that have already settled, with the
          sample size attached to every claim — and tests whether an agent&rsquo;s edge survives the
          spread before any capital moves. Nothing here needs a wallet to read.
        </p>

        <div className="row" style={{ marginTop: 24, marginBottom: 8 }}>
          <Link className="btn primary big" href="/markets">Explore Markets</Link>
          <Link className="btn big" href="/agents">Test an Agent</Link>
          {/* Thirty seconds, no account, no reading. It existed for exactly this
              reader and was reachable only by typing the URL. */}
          <Link className="btn big" href="/demo">Watch one run</Link>
        </div>

        {/* The two problems, stated once each. Both are things this project
            actually measured rather than positions it decided to hold. */}
        <div className="sec-head">
          <h2>Two problems, both measurable</h2>
        </div>

        <div className="grid cols-2">
          <div className="panel">
            <h3>A probability is not self-explanatory</h3>
            <p style={{ maxWidth: "56ch" }}>
              DreamDEX may say BTC UP 15m is 67%. Nothing on the venue tells you whether contracts that
              quoted 67% went on to settle true about 67% of the time — which is the only question that
              number raises.
            </p>
            <p style={{ maxWidth: "56ch", marginBottom: 0 }}>
              Rivo measures it against contracts that have already settled, with the sample size attached
              to every claim.
            </p>
            <div className="row" style={{ marginTop: 14 }}>
              <Link className="btn" href="/calibration">See the calibration</Link>
            </div>
          </div>

          <div className="panel">
            <h3>Prediction accuracy is not economic edge</h3>
            <p style={{ maxWidth: "56ch" }}>
              A model can predict well and still trade badly — being right about direction is not the
              same as being right by more than the spread you cross. So {BASELINES.length + 1} strategies
              now run against live Event Contracts, deciding but never spending, each resolved against
              the venue&rsquo;s own settlement.
            </p>
            <p style={{ maxWidth: "56ch", marginBottom: 0 }}>
              Rivo&rsquo;s own model is one of them, and it is the one that failed: AUC{" "}
              {PRODUCTION_STRATEGY.auc}, {pct(PRODUCTION_STRATEGY.returnOnStake)} return on stake out of
              sample. It is marked <strong>{PRODUCTION_STRATEGY.state}</strong>, and the execution path
              enforces that rather than displaying it.
            </p>
            <div className="row" style={{ marginTop: 14 }}>
              <Link className="btn" href="/agents">See what cleared the spread</Link>
            </div>
          </div>
        </div>

        <div className="sec-head">
          <h2>Understand, validate, prove</h2>
          <span className="hint">and every outcome feeds the next answer</span>
        </div>

        <div className="panel">
          <ol className="flow">
            <li>
              <span className="n">Understand</span>
              <p>
                Live Event Contracts with implied probability, spread, depth and time to expiry — beside
                how often comparable contracts actually settled true.
              </p>
            </li>
            <li>
              <span className="n">Validate</span>
              <p>
                An agent is replayed against settled history with walk-forward validation, and judged on
                realised economics rather than accuracy — with the sample size and the interval attached,
                and no verdict at all until there is enough of both. The result is a state the execution
                path reads.
              </p>
            </li>
            <li>
              <span className="n">Shadow</span>
              <p>
                It then runs against live markets deciding but not spending. Each decision is recorded and
                resolved against the real settlement when the contract closes.
              </p>
            </li>
            <li>
              <span className="n">Prove</span>
              <p>
                Only then, and only on an approved testnet, does a decision become a real DreamDEX
                transaction — with the hash, the receipt and the reconciliation all inspectable.
              </p>
            </li>
            <li>
              <span className="n">Evidence</span>
              <p>
                Every settled contract joins the calibration dataset and the agent&rsquo;s record, so the
                next answer rests on one more settled fact than the last.
              </p>
            </li>
          </ol>
        </div>

        <div className="sec-head">
          <h2>What Rivo does not claim</h2>
        </div>
        <div className="panel">
          <div className="defs">
            <div>
              <div className="t">That its strategy is profitable</div>
              <div className="d">It is not, and the evidence saying so is published rather than buried.</div>
            </div>
            <div>
              <div className="t">That calibration predicts the future</div>
              <div className="d">It describes what has already settled. Nothing more is claimed from it.</div>
            </div>
            <div>
              <div className="t">That a disagreement is a mispricing</div>
              <div className="d">
                A gap between the market and a model is a thing to understand before it is a thing to
                trade. Market intelligence here is descriptive — never BUY or SELL.
              </div>
            </div>
            <div>
              <div className="t">That testnet results mean mainnet results</div>
              <div className="d">
                An economically rejected strategy cannot reach real capital on any network, and the gate
                enforces it in code.
              </div>
            </div>
          </div>
        </div>
      </main>

      <footer className="wrap" style={{ paddingBottom: 44, paddingTop: 18, borderTop: "1px solid var(--line)" }}>
        <p className="muted" style={{ marginBottom: 6 }}>
          <strong>Understand the market. Validate the agent. Prove it on DreamDEX.</strong>
        </p>
        <p className="hint" style={{ marginBottom: 0 }}>
          Built on the official DreamDEX bot kit and the Somnia indexer.{" "}
          <a href="https://github.com/Rzbyte/Rivo">Source</a> ·{" "}
          <Link href="/demo">Live run</Link> ·{" "}
          <Link href="/app">Deployment console</Link>
        </p>
      </footer>
    </>
  );
}
