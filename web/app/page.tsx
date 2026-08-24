// The landing page.
//
// It has one job and it is not to ask for a wallet. Somebody arriving has no
// idea whether a DreamDEX probability means anything, and the fastest way to
// lose them is to answer that with a Connect button.
//
// The previous version opened on "Set a budget and a risk profile once" — a
// consumer fund-manager pitch for a product whose own research says its strategy
// should not receive capital. Those two things cannot both be on the same site.

import Link from "next/link";
import { Nav } from "@/components/Nav";

export default function Landing() {
  return (
    <>
      <Nav />
      <main className="wrap" style={{ paddingTop: 40, paddingBottom: 72 }}>
        <span className="label">DreamDEX Event Contracts · Somnia</span>
        <h1 style={{ maxWidth: "17ch", marginTop: 10 }}>
          Understand DreamDEX probabilities. Test agents before they trade.
        </h1>
        <p className="lede">
          Live Event Contract intelligence, economic validation, shadow testing, and verifiable DreamDEX
          testnet execution. Nothing here needs a wallet to read.
        </p>

        <div className="row" style={{ marginTop: 24, marginBottom: 8 }}>
          <Link className="btn primary big" href="/markets">Explore Markets</Link>
          <Link className="btn big" href="/agents">Test an Agent</Link>
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
              Rivo found this out about itself. Its own model separates up from down well — AUC 0.8158,
              measured — and trading it lost money out of sample at −6.49% return on stake.
            </p>
            <p style={{ maxWidth: "56ch", marginBottom: 0 }}>
              So Rivo V1 is marked <strong>REJECTED</strong>, and the execution path enforces that rather
              than displaying it. A model can predict well and still trade badly.
            </p>
            <div className="row" style={{ marginTop: 14 }}>
              <Link className="btn" href="/agents">See the verdict</Link>
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
                realised economics rather than accuracy. The verdict is a state the execution path reads.
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
          <Link href="/app">Deployment console</Link>
        </p>
      </footer>
    </>
  );
}
