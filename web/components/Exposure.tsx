"use client";

// Correlated exposure, shown as the budget it actually is.
//
// The number is collateral gained or lost per 1% move in the underlying, which
// is the one framing that makes BTC and ETH comparable — a unit move in BTC at
// 68,000 is nothing like a unit move in ETH at 2,100, and a raw share count
// hides that completely.
//
// The sign matters and is kept: a portfolio holding UP on one tenor and DOWN on
// another is less exposed than either leg alone, and a bar chart of absolute
// values would show the opposite.

import type { PortfolioView } from "@rivo/db/view.js";
import { Meter } from "./Dashboard";

export function Exposure({ view }: { view: PortfolioView }) {
  return (
    <div className="panel">
      <div className="spread" style={{ marginBottom: 12 }}>
        <h3 style={{ margin: 0 }}>Correlated exposure</h3>
        {/* The explanation is what makes this panel mean anything, and it is also
            the thing a returning user has read ten times. Behind a disclosure it
            is available without being in the way. */}
        <details style={{ fontSize: 12 }}>
          <summary className="faint" style={{ cursor: "pointer", listStyle: "none" }}>
            what is this?
          </summary>
          <p className="hint" style={{ marginTop: 6, marginBottom: 0, maxWidth: "42ch" }}>
            What a 1% move in each underlying is worth to this portfolio, across every tenor at once. This is
            the budget that makes Rivo refuse a second good-looking BTC window. Positive means the portfolio
            gains when the underlying rises, so UP at one tenor and DOWN at another net off — exactly as they
            do in reality.
          </p>
        </details>
      </div>
      {view.exposure.map((e) => (
        <div key={e.asset} style={{ marginBottom: 12 }}>
          <div className="spread">
            <strong>{e.asset}</strong>
            <span className="num">
              <span className={e.delta >= 0 ? "pos" : "neg"}>
                {e.delta >= 0 ? "+" : ""}
                {e.delta.toFixed(2)}
              </span>
              <span className="faint"> / {e.cap.toFixed(2)} per 1%</span>
            </span>
          </div>
          <Meter used={e.used} />
          <div className="hint">
            {e.deployed > 0
              ? `${e.deployed.toFixed(2)} committed · ${(e.used * 100).toFixed(0)}% of the limit used`
              : "nothing held"}
          </div>
        </div>
      ))}
    </div>
  );
}
