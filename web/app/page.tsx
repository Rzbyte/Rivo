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



export default function Landing() {
  return (
    <>
      <Nav />
      {/* Background Orbs */}
      <div className="orb one"></div>
      <div className="orb two animate-float"></div>

      <main className="wrap animate-fade-in" style={{ paddingBottom: 72 }}>
        
        {/* Extreme Hero Section */}
        <section className="hero">
          <div className="badges">
            {/* Somnia Shannon, chain 50312. The execution mode is
                `experimental_testnet` and the gate refuses mainnet outright for
                a REJECTED strategy — so a mainnet badge would be claiming the
                one thing the code below it exists to prevent. */}
            <span className="badge pulse">
              <span className="dot"></span> LIVE ON SOMNIA TESTNET
            </span>
            <span className="badge">DREAMDEX INTEGRATED</span>
          </div>
          
          <h1 className="text-gradient">
            Event Contracts, <br /> Proven Before Trading.
          </h1>
          
          <p className="lede" style={{ maxWidth: "600px" }}>
            Rivo scores DreamDEX&rsquo;s own Event Contract prices against contracts that have already
            settled, and tests whether an agent&rsquo;s edge survives the spread before any capital
            moves. Nothing here needs a wallet to read.
          </p>

          <div className="row" style={{ marginTop: 32 }}>
            <Link className="btn primary big" href="/check">Check an Asset</Link>
            <Link className="btn btn-glass big" href="/markets">Explore Live Markets</Link>
          </div>
        </section>

        {/* Bento Box Grid */}
        <section className="bento-grid">
          
          <div className="bento-card bento-wide">
            <div>
              <svg className="bento-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="6"></circle><circle cx="12" cy="12" r="2"></circle></svg>
              <h3>Forecast vs Reality</h3>
              <p>
                A probability is just an opinion until scored. We measure every claim against historically settled contracts with hard data.
              </p>
            </div>
            <div className="row" style={{ marginTop: 24 }}>
              <Link className="btn btn-glass" href="/calibration">View Calibration Data</Link>
            </div>
          </div>

          <div className="bento-card bento-tall">
            <div>
              <svg className="bento-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
              <h3>Execution Engine</h3>
              <p>
                {BASELINES.length + 1} distinct strategies shadow the live market, calculating the spread cross before making a decision. 
              </p>
              {/* Both numbers, from the constant the execution gate reads.
                  Rivo&rsquo;s own model is the first thing this apparatus was
                  pointed at, and it failed — a validator that never rejects
                  anything is a rubber stamp. */}
              <div className="verdict caution" style={{ marginTop: 16 }}>
                AUC {PRODUCTION_STRATEGY.auc} · ROS{" "}
                {`${PRODUCTION_STRATEGY.returnOnStake >= 0 ? "+" : ""}${(PRODUCTION_STRATEGY.returnOnStake * 100).toFixed(2)}%`}{" "}
                — {PRODUCTION_STRATEGY.state}
              </div>
              <p className="hint" style={{ marginTop: 10, marginBottom: 0 }}>
                Rivo&rsquo;s own model failed its economic validation, and the gate enforces that
                rather than displaying it.
              </p>
            </div>
            <div className="row" style={{ marginTop: 24 }}>
              <Link className="btn primary" href="/agents" style={{ width: "100%", justifyContent: "center" }}>
                Analyze Agents
              </Link>
            </div>
          </div>

          <div className="bento-card">
            <div>
              <svg className="bento-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>
              <h3>Capital Safe</h3>
              <p>
                A strategy&rsquo;s verdict is computed before an executor is built, so a rejected one cannot reach a signer on any network.
              </p>
            </div>
          </div>

          <div className="bento-card bento-wide">
            <div>
              <svg className="bento-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>
              <h3>On-Chain Evidence</h3>
              <p>
                Every decision and execution is written to an append-only ledger before it is signed, so a crash leaves a record rather than a gap.
              </p>
            </div>
            <div className="row" style={{ marginTop: 24 }}>
              <Link className="btn btn-glass" href="/demo">Watch Live Run</Link>
            </div>
          </div>

        </section>

        {/* Transparency Banner */}
        {/* What Rivo does not claim.
            Kept as a list rather than a sentence because each line refuses a
            different thing, and the fourth one is the reason the badge at the
            top of this page says testnet. */}
        <div className="banner warn" style={{ maxWidth: "800px", margin: "0 auto" }}>
          <strong>What Rivo does not claim</strong>
          <ul style={{ margin: "10px 0 0", paddingLeft: 20, lineHeight: 1.7 }}>
            <li>That its strategy is profitable — it is REJECTED, and the gate enforces it.</li>
            <li>That calibration predicts the future. It describes contracts that already settled.</li>
            <li>That a disagreement is a mispricing. The spread and the depth may eat it.</li>
            <li>That testnet results mean mainnet results.</li>
          </ul>
        </div>
      </main>

      <footer className="wrap" style={{ paddingBottom: 44, paddingTop: 40, borderTop: "1px solid rgba(255,255,255,0.1)", textAlign: "center" }}>
        <p className="hint" style={{ marginBottom: 0 }}>
          Powered by Somnia Indexer & DreamDEX. <br/>
          <a href="https://github.com/Rzbyte/Rivo">Source</a> · <Link href="/demo">Demo</Link>
        </p>
      </footer>
    </>
  );
}
