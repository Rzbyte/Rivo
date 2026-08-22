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

      <main className="wrap" style={{ paddingTop: 56, paddingBottom: 72 }}>
        <span className="label">DreamDEX Event Contracts · Somnia {NETWORK}</span>
        <h1 style={{ maxWidth: "18ch", marginTop: 10 }}>
          An autonomous portfolio manager, not a bot that takes every trade.
        </h1>
        <p className="lede">
          Set a budget and a risk profile once. Rivo prices every live window against that window&rsquo;s own
          settlement reference, sizes the whole term structure as a single exposure, manages what it holds,
          redeems what settles, and redeploys the proceeds. You can close the tab.
        </p>

        <div className="row" style={{ marginTop: 26, marginBottom: 44 }}>
          <button className="primary" disabled={!ready} onClick={() => login()}>
            Continue with email, Google, or a wallet
          </button>
          <a className="btn" href="https://github.com/somnia-chain/dreamdex-bot-kit">
            Built on the official kit
          </a>
        </div>

        <TheDifference />

        <section className="grid cols-3" style={{ marginTop: 34 }}>
          <Feature
            title="No private keys"
            body="Sign in with an email address. Rivo gives you a portfolio wallet held by Privy — Rivo never has the key, and you can withdraw its permission to sign at any moment."
          />
          <Feature
            title="No per-trade popups"
            body="A window settles at 3am whether or not a browser is open. Once Autopilot is on, the work happens server-side and you are not asked to approve anything."
          />
          <Feature
            title="Every decision recorded"
            body="Not just fills. Every leg considered, priced, and refused, with the constraint that bound it — and every transaction, kept after the position that produced it is gone."
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
      <h2 style={{ marginTop: 8 }}>Three positive edges. One position.</h2>
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
