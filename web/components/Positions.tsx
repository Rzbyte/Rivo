"use client";

// What is held, and what was held.
//
// Closed positions carry the transactions that produced them, read from the
// execution ledger rather than from the position — which is the point of having
// a ledger at all. An adopted position is labelled as such wherever it appears:
// nothing on-chain records what was paid for it, so its cost basis is an
// estimate and every number derived from it inherits that.

import type { PortfolioView, ClosedPositionView } from "@rivo/db/view.js";
import { tenorLabel } from "@rivo/core/venue.js";
import { explorerTx } from "@/lib/somnia";

export function Positions({ view, closed }: { view: PortfolioView; closed: ClosedPositionView[] }) {
  return (
    <>
      <div className="panel">
        <h3>Open</h3>
        {view.positions.length === 0 ? (
          <p className="faint" style={{ marginBottom: 0, fontSize: 13 }}>
            Nothing open right now.
          </p>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Market</th>
                  <th className="n">Shares</th>
                  <th className="n">Entry</th>
                  <th className="n">Cost</th>
                  <th className="n">Model at entry</th>
                  <th className="n">Δ per 1%</th>
                  <th>Settles</th>
                </tr>
              </thead>
              <tbody>
                {view.positions.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <strong className="mono">
                        {p.asset} {p.leg}
                      </strong>{" "}
                      <span className="faint">{tenorLabel(p.intervalSec)}</span>
                      {p.adopted && (
                        <span className="pill warn" style={{ marginLeft: 6, fontSize: 10 }} title="Found on-chain rather than opened by Rivo — its entry price is an estimate.">
                          adopted
                        </span>
                      )}
                    </td>
                    <td className="n">{p.shares.toFixed(2)}</td>
                    <td className="n">{p.entryPrice.toFixed(3)}</td>
                    <td className="n">{p.cost.toFixed(2)}</td>
                    <td className="n">{(p.fairAtEntry * 100).toFixed(1)}%</td>
                    <td className={`n ${p.deltaPer1PctPerShare >= 0 ? "pos" : "neg"}`}>
                      {(p.shares * p.deltaPer1PctPerShare).toFixed(2)}
                    </td>
                    <td className="mono faint">{new Date(p.expiry * 1000).toISOString().slice(11, 16)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel">
        <h3>Closed</h3>
        {closed.length === 0 ? (
          <p className="faint" style={{ marginBottom: 0, fontSize: 13 }}>
            Nothing has settled yet.
          </p>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Market</th>
                  <th className="n">Shares</th>
                  <th className="n">Cost</th>
                  <th className="n">Proceeds</th>
                  <th className="n">Result</th>
                  <th>How it ended</th>
                  <th>Transactions</th>
                </tr>
              </thead>
              <tbody>
                {closed.map((p) => {
                  const pnl = p.proceeds - p.cost;
                  return (
                    <tr key={p.id}>
                      <td>
                        <strong className="mono">
                          {p.asset} {p.leg}
                        </strong>{" "}
                        <span className="faint">{tenorLabel(p.intervalSec)}</span>
                      </td>
                      <td className="n">{p.shares.toFixed(2)}</td>
                      <td className="n">{p.cost.toFixed(2)}</td>
                      <td className="n">{p.proceeds.toFixed(2)}</td>
                      <td className={`n ${pnl >= 0 ? "pos" : "neg"}`}>
                        {pnl >= 0 ? "+" : ""}
                        {pnl.toFixed(2)}
                      </td>
                      <td title={EXIT[p.exit] ?? ""}>{p.exit}</td>
                      <td className="mono">
                        {p.txHashes.length === 0 ? (
                          <span className="faint">—</span>
                        ) : (
                          p.txHashes.map((h) => (
                            <a key={h} href={explorerTx(h)} target="_blank" rel="noreferrer" style={{ marginRight: 8 }}>
                              {h.slice(0, 8)}…
                            </a>
                          ))
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

const EXIT: Record<string, string> = {
  settled: "The window resolved and the position paid out, or did not.",
  sold: "Rivo sold into the book before expiry.",
  merged: "Recovered as collateral by merging a complete set.",
  voided: "The market was voided; every holder was refunded at half.",
  dropped: "Reconciliation removed it — the chain said the wallet never held it.",
};
