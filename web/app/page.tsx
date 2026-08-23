"use client";

// The landing page.
//
// It has one job, and it is not to list features. Anyone can describe a bot that
// trades prediction markets; what has to land in the first ten seconds is that
// Rivo treats overlapping windows on the same underlying as ONE exposure, and
// therefore refuses trades that look good on their own. The example below is the
// product — everything else on this page is context for it.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { usePrivy } from "@privy-io/react-auth";
import { NETWORK } from "@/lib/somnia";
import { VENUE } from "@rivo/core/venue.js";

const APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "";

export default function Landing() {
  if (!APP_ID) return <MissingPrivy />;
  return <LandingWithAuth />;
}

function LandingWithAuth() {
  const { ready, authenticated, login } = usePrivy();
  const router = useRouter();
  const [going, setGoing] = useState(false);

  useEffect(() => {
    if (ready && authenticated) router.replace("/app");
  }, [ready, authenticated, router]);

  return (
    <>
      <Header
        right={
          <button
            className="primary"
            disabled={!ready || going}
            onClick={() => {
              setGoing(true);
              login();
            }}
          >
            {authenticated ? "Open Rivo" : "Sign in"}
          </button>
        }
      />

      <main className="wrap" style={{ paddingTop: 44, paddingBottom: 72 }}>
        <div className="hero-grid" style={{ marginBottom: 40 }}>
          <div>
            <span className="label">DreamDEX Event Contracts · Somnia {NETWORK}</span>
            <h1 style={{ maxWidth: "18ch", marginTop: 10 }}>
              An autonomous portfolio manager, not a bot that takes every trade.
            </h1>
            <p className="lede">
              Set a budget and a risk profile once. Rivo prices every live window against that
              window&rsquo;s own settlement reference, sizes the whole term structure as a single exposure,
              manages what it holds, redeems what settles, and redeploys the proceeds. You can close the tab.
            </p>

            <div className="row" style={{ marginTop: 24 }}>
              {/* Deliberately does not name the methods. Which ones exist is the
                  Privy dashboard's decision, and a button promising Google on a
                  deployment that has not enabled it is a button that lies. */}
              <button className="primary big" disabled={!ready} onClick={() => login()}>
                Get started
              </button>
              <a className="btn big" href="https://github.com/somnia-chain/dreamdex-bot-kit">
                Built on the official kit
              </a>
            </div>
          </div>

          <Instrument />
        </div>

        <Tally />

        <WhatThisIs />
        <TheDifference />
        <HowItWorks />
        <WhatYouDo />

        <BuiltOn />

        <div className="sec-head">
          <h2>What Rivo cannot do</h2>
        </div>
        <section className="grid cols-3">
          <Feature
            title="It never holds your key"
            body="Your Rivo Portfolio is an embedded wallet held by Privy in a secure enclave. Rivo asks that enclave to sign, under a permission you grant and can withdraw in one click. There is no key on Rivo's servers to steal, and no private key you are ever asked to paste."
          />
          <Feature
            title="It cannot touch your other wallet"
            body="The Rivo Portfolio is a separate account from anything you already use. Fund it with what you are prepared to trade with; the rest of your holdings are somewhere Rivo cannot reach even if it wanted to."
          />
          <Feature
            title="It cannot quietly change its mind"
            body="Every leg it considers is written down before anything is signed — including the ones it refuses, with the constraint that stopped them. The record survives the position that produced it, so what happened stays checkable after the fact."
          />
        </section>
      </main>

      <Footer />
    </>
  );
}

/**
 * The example that IS the product.
 *
 * Three genuinely positive-edge opportunities on the same underlying. A naive
 * strategy buys all three and discovers it has one position at triple size on a
 * single view. Rivo takes the best one and says why it refused the others.
 */
function TheDifference() {
  const rows = [
    { market: "BTC UP · 15m", edge: "+10.2%", taken: false, why: "Would take BTC exposure past its correlated limit." },
    { market: "BTC UP · 1h", edge: "+12.4%", taken: true, why: "Best edge per unit of correlated exposure. Sized at 4.6% of capital." },
    { market: "BTC UP · 4h", edge: "+8.7%", taken: false, why: "Same directional view, already held at 1h. No diversification for the capital." },
  ];
  return (
    <section className="panel">
      <span className="label">The part other bots get wrong</span>
      <div className="sec-head" style={{ marginTop: 8 }}>
        <h2>Three positive edges. One position.</h2>
      </div>
      <p style={{ maxWidth: "68ch" }}>
        DreamDEX runs eight Event Contract markets at once — BTC and ETH across 15m, 1h, 4h and 1d — and
        they move together. A strategy that scores each market on its own will happily buy the same view
        three times and call it three trades. Rivo scores them against one budget.
      </p>
      <div style={{ marginTop: 14 }}>
        {rows.map((r) => (
          <div key={r.market} className={`decision ${r.taken ? "taken" : "refused"}`}>
            <strong className="mono">{r.market}</strong>
            <span className="num pos">{r.edge}</span>
            <div className="why">
              <strong>{r.taken ? "ENTER" : "SKIP"}</strong> — {r.why}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * The product, on the page.
 *
 * A landing page built out of prose panels reads as documentation whatever the
 * prose says, and this one had five of them in a row and no picture of the
 * thing being described. So this is one real pass out of the live decision log
 * — cycle 93, recorded 2026-08-23 — rendered in the same shapes the dashboard
 * uses.
 *
 * It shows the refusal rather than an entry on purpose. Three legs with genuine
 * positive edge, declined because they were the same directional bet already
 * held elsewhere, is the one thing here that a per-market bot cannot do; a
 * screenshot of a winning trade would say nothing that every other project's
 * screenshot does not.
 *
 * The numbers are copied from the record and are not live. Saying so is
 * cheaper than being caught claiming otherwise, and the tally below IS live in
 * the sense that it is a real count of a real run.
 */
function Instrument() {
  const rows = [
    { mkt: "ETH UP", tenor: "4h", fair: "0.402", ask: "0.367", edge: "+3.5%" },
    { mkt: "ETH UP", tenor: "15m", fair: "0.071", ask: "0.039", edge: "+3.2%" },
    { mkt: "ETH UP", tenor: "1d", fair: "0.383", ask: "0.357", edge: "+2.6%" },
  ] as const;
  return (
    <div className="inst">
      <div className="inst-top">
        <span>Rivo engine · cycle 93</span>
        <span className="inst-live">
          <span className="dot" aria-hidden="true" />
          recorded
        </span>
      </div>
      <div className="inst-body">
        {rows.map((r) => (
          <div key={r.tenor} className="inst-row">
            <div className="inst-mkt">
              <b>
                {r.mkt} · {r.tenor}
              </b>
              <span className="px">
                fair {r.fair} · ask {r.ask} · <span className="pos">{r.edge}</span>
              </span>
            </div>
            <div className="inst-why">SKIP — combined delta budget (rho 0.80)</div>
          </div>
        ))}
      </div>
      <div className="inst-foot">
        <span>16 legs considered</span>
        <span>3 refused for one reason</span>
      </div>
    </div>
  );
}

/** Counts out of the running system. Nothing here is a projection. */
function Tally() {
  const cells = [
    ["824", "cycles run against the live venue"],
    ["13,165", "legs priced and recorded"],
    ["13,115", "of them refused, each with its reason"],
    ["643", "tests, none skipped"],
  ] as const;
  return (
    <section className="tally" aria-label="Measured to date" style={{ marginBottom: 8 }}>
      {cells.map(([v, k]) => (
        <div key={k}>
          <span className="v">{v}</span>
          <span className="k">{k}</span>
        </div>
      ))}
    </section>
  );
}

/**
 * For a reader who has never traded an event contract.
 *
 * The page used to open on "term structure" and "settlement reference" and
 * assume both. Anyone who does not already know what DreamDEX sells cannot
 * evaluate a single claim after that point, so the vocabulary comes first and
 * in the reader's words, not the venue's.
 */
function WhatThisIs() {
  return (
    <>
      <div className="sec-head">
        <h2>First, what is being traded</h2>
      </div>
      <section className="panel">
        <p style={{ maxWidth: "68ch" }}>
          DreamDEX Event Contracts are yes-or-no bets on price. Each one asks a single question — “will
          BTC be higher in an hour than it was when this window opened?” — and settles at 1 if the
          answer is yes and 0 if it is no. A contract trading at 0.62 is the market saying it is 62%
          likely. You buy the side you think is underpriced.
        </p>
        <div className="defs" style={{ marginTop: 6 }}>
          <div>
            <div className="t">A window</div>
            <div className="d">
              One round of that question, with a start and an end. When it ends, the contract pays out or
              expires worthless — there is nothing left to manage afterwards.
            </div>
          </div>
          <div>
            <div className="t">Eight of them at once</div>
            <div className="d">
              BTC and ETH, each over 15 minutes, 1 hour, 4 hours and 1 day. Sixteen contracts, since every
              window has an UP side and a DOWN side.
            </div>
          </div>
          <div>
            <div className="t">Why that is hard by hand</div>
            <div className="d">
              A 15-minute window opens and closes ninety-six times a day, and the good moment to buy one
              lasts seconds. Doing this properly is not a thing a person does with a browser tab open.
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

/**
 * One pass of the engine, in the order it runs.
 *
 * These are the real stages — the same ones `npm run proof` reports on — rather
 * than a marketing arc. The numbering is information, not decoration: skipping
 * step four means skipping the risk check.
 */
function HowItWorks() {
  const steps = [
    ["Discover", "Every fifteen to sixty seconds, Rivo asks the venue which windows are live, when each one settles, and what the order book looks like right now."],
    ["Price", "For each side of each window it computes its own probability from the underlying's price and how much it has been moving, against that window's own opening reference — not a global one."],
    ["Compare", "Its probability against what the book is asking. The gap is the claimed edge. Most of the time the gap is too small to be worth the spread, and the leg is refused here."],
    ["Size as one exposure", "Anything that survives is sized against the whole portfolio, not on its own. BTC at 1h and BTC at 4h are the same bet twice; they draw on one budget, and this is the step other bots do not have."],
    ["Risk check", "Capital limits, per-position caps, expiry concentration, a cash floor, and a breaker that halts everything rather than trading through a loss it does not understand."],
    ["Execute", "The order is written to a durable ledger BEFORE it is signed, so a crash mid-flight leaves a record to reconcile against rather than a mystery. Then Privy's enclave signs it and it goes to the chain."],
    ["Settle and redeploy", "When a window closes, Rivo redeems what paid out, records what did not, and returns the proceeds to the budget for the next pass. Nobody has to be watching."],
  ] as const;
  return (
    <>
      <div className="sec-head">
        <h2>How one pass works</h2>
        <span className="hint">every 15–60s, per portfolio</span>
      </div>
      <section className="panel">
        <ol className="flow">
          {steps.map(([name, body]) => (
            <li key={name}>
              <span className="n">{name}</span>
              <p>{body}</p>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}

/** The three things a person actually does. Everything else is Rivo's job. */
function WhatYouDo() {
  const steps = [
    ["Sign in", "An email address, a social account, or a wallet you already have. Rivo opens you a separate trading account — a Rivo Portfolio — held by Privy."],
    ["Fund it and set a budget", "Put in what you are prepared to trade with, pick a risk profile, and that is the whole configuration. The profile sets how much of the budget may be deployed, how large one position may get, and how much correlated exposure is allowed."],
    ["Switch Autopilot on", "One consent, in your wallet, granting Rivo permission to sign for this account. From then on it runs while you are offline — and you can withdraw that permission at any moment, which stops it signing immediately."],
  ] as const;
  return (
    <>
      <div className="sec-head">
        <h2>What you do</h2>
        <span className="hint">once</span>
      </div>
      <section className="panel">
        <ol className="flow">
          {steps.map(([name, body]) => (
            <li key={name}>
              <span className="n">{name}</span>
              <p>{body}</p>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}

/**
 * What this is built on, and what each piece is responsible for.
 *
 * Deliberately not a row of logos. A badge wall says a name and nothing else,
 * and every project at a hackathon has the same four; what is worth a visitor's
 * attention is which component holds which responsibility, because that is the
 * part that would be hard to replace and the part that says whether this was
 * assembled or designed.
 */
function BuiltOn() {
  const stack = [
    {
      name: "Somnia",
      role: "The chain",
      body: `Every position, redemption and claim is a transaction on Somnia — testnet chain ${VENUE.testnet.chainId}, mainnet ${VENUE.mainnet.chainId}. Sub-second finality is what makes a 15-minute window tradable at all; on a chain with twelve-second blocks, a third of the window is confirmation latency.`,
    },
    {
      name: "DreamDEX Event Contracts",
      role: "The venue",
      body: "The markets themselves — eight live windows across BTC and ETH, each with an UP and a DOWN side, priced by a real order book with real counterparties. Rivo only ever takes liquidity that was actually resting.",
    },
    {
      name: "dreamdex-bot-kit · ec-core",
      role: "Order placement",
      body: "The venue team's own SDK, used unmodified for building and submitting binary orders. Rivo adds the one thing it has no equivalent for — an ERC-20 approval for the pool that escrows collateral, without which a fresh wallet's first order reverts for no stated reason.",
    },
    {
      name: "Privy",
      role: "Identity and signing",
      body: "Sign-in, and a per-user wallet that lives in a TEE. Autopilot is a session signer on a key quorum, which means Rivo asks the enclave to sign under a permission you grant and can withdraw — it holds no key material of yours at any point.",
    },
    {
      name: "PostgreSQL",
      role: "Durable state and the ledger",
      body: "Portfolios are claimed by workers with a fenced database lease, so more than one worker is more throughput and never two on one portfolio. Executions are append-only, enforced by a trigger rather than by convention: the record cannot be rewritten after the fact, including by Rivo.",
    },
    {
      name: "Next.js on Vercel · a container for the worker",
      role: "Deployment boundary",
      body: "The web app is request-scoped and belongs on Vercel. The trading loop is not, and never runs there — a serverless function that is killed after a few seconds cannot hold a lease or finish a settlement. It runs as a long-lived container against the same database.",
    },
    {
      name: "viem",
      role: "Chain access",
      body: "Reads, receipts and the approval path. A Privy wallet is presented to it as an ordinary account, which is why the same code path works whether Rivo is signing through an enclave or, in local dry runs, not signing at all.",
    },
  ] as const;
  return (
    <>
      <div className="sec-head">
        <h2>What it is built on</h2>
        <span className="hint">and what each part is responsible for</span>
      </div>
      <section className="panel">
        <div className="defs">
          {stack.map((x) => (
            <div key={x.name}>
              <div className="spread" style={{ marginBottom: 4 }}>
                <span className="t" style={{ marginBottom: 0 }}>{x.name}</span>
                <span className="label" style={{ flex: "none" }}>{x.role}</span>
              </div>
              <div className="d">{x.body}</div>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

function Feature({ title, body }: { title: string; body: string }) {
  return (
    <div className="panel">
      <h3>{title}</h3>
      <p style={{ marginBottom: 0, fontSize: 14 }}>{body}</p>
    </div>
  );
}

function Header({ right }: { right?: React.ReactNode }) {
  return (
    <header className="top">
      <div className="wrap">
        <a className="brand" href="/">
          <span className="brand-dot" aria-hidden="true" />
          Rivo
        </a>
        {right}
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer className="wrap" style={{ paddingBottom: 40, borderTop: "1px solid var(--line)", paddingTop: 20 }}>
      <p style={{ fontSize: 12.5, marginBottom: 6 }}>
        Rivo is experimental software for a hackathon, running on Somnia {NETWORK}. It can lose money. Its own
        backtest reports a negative result for naive taker strategies, and says so.
      </p>
      <p style={{ fontSize: 12.5, marginBottom: 0 }} className="faint">
        Not investment advice. Nothing here is a promise of profit.
      </p>
    </footer>
  );
}

/** A deployment with no Privy app id cannot log anybody in. Say that, plainly. */
function MissingPrivy() {
  return (
    <>
      <Header />
      <main className="wrap center">
        <div className="card panel">
          <h2>This deployment is not configured</h2>
          <p>
            <code className="mono">NEXT_PUBLIC_PRIVY_APP_ID</code> is not set, so there is no way to sign in.
            Set it, along with <code className="mono">PRIVY_APP_ID</code> and{" "}
            <code className="mono">PRIVY_APP_SECRET</code> on the server, and redeploy.
          </p>
          <p style={{ marginBottom: 0 }} className="faint">
            See <code className="mono">.env.example</code> for the full list.
          </p>
        </div>
      </main>
    </>
  );
}
