"use client";

// The centre of the product.
//
// A cycle is shown WHOLE — everything Rivo looked at in one pass, entries and
// refusals together — because the interesting fact is never a single trade. It
// is that four legs had positive edge and one was taken, and that the reason the
// other three were refused is the same reason a person managing this by hand
// would have refused them.
//
// So refusals are not greyed out or collapsed. They are the same size as the
// entries, and each one carries the constraint that bound it.

import type { DecisionGroup } from "@rivo/db/view.js";
import { tenorLabel } from "@rivo/core/venue.js";

export function Decisions({ groups }: { groups: DecisionGroup[] }) {
  if (groups.length === 0) {
    return (
      <div className="panel">
        <p className="faint" style={{ marginBottom: 0 }}>
          No decisions recorded yet. The first cycle will appear here within a minute of Autopilot starting.
        </p>
      </div>
    );
  }
  return (
    <>
      {groups.map((g) => (
        <div className="panel" key={g.cycle}>
          <div className="spread" style={{ marginBottom: 4 }}>
            <div>
              <span className="label">Cycle {g.cycle}</span>
              <h3 style={{ marginTop: 2 }}>{headline(g)}</h3>
            </div>
            <span className="faint mono" style={{ fontSize: 12 }}>
              {new Date(g.at * 1000).toISOString().slice(11, 19)}
            </span>
          </div>

          {g.bindings.length > 0 && (
            <div className="row" style={{ marginBottom: 8 }}>
              {g.bindings.slice(0, 4).map((b) => (
                <span key={b.binding} className="pill" title={`${b.count} leg(s) refused for this reason`}>
                  {b.binding} ×{b.count}
                </span>
              ))}
            </div>
          )}

          {[...g.entered, ...g.managed, ...g.skipped].map((d, i) => {
            const taken = d.action !== "SKIP";
            return (
              <div className={`decision ${taken ? "taken" : "refused"}`} key={`${d.marketId}-${d.leg}-${i}`}>
                <strong className="mono">
                  {d.asset} {d.leg} · {tenorLabel(d.intervalSec)}
                </strong>
                <span className="num">
                  {Number.isFinite(d.fair) && (
                    <>
                      <span className="faint">model </span>
                      {(d.fair * 100).toFixed(1)}%
                    </>
                  )}
                  {d.ask !== null && (
                    <>
                      <span className="faint"> · ask </span>
                      {(d.ask * 100).toFixed(1)}%
                    </>
                  )}
                  {d.edge !== null && (
                    <>
                      <span className="faint"> · edge </span>
                      <span className={d.edge >= 0 ? "pos" : "neg"}>
                        {d.edge >= 0 ? "+" : ""}
                        {(d.edge * 100).toFixed(1)}%
                      </span>
                    </>
                  )}
                </span>
                <div className="why">
                  <strong>{d.action}</strong>
                  {d.shares > 0 && (
                    <span className="mono">
                      {" "}
                      {d.shares.toFixed(2)} shares · {d.cost.toFixed(2)}
                    </span>
                  )}{" "}
                  — {d.binding}
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </>
  );
}

/**
 * One sentence describing the pass.
 *
 * Deliberately leads with the refusals when there are any, because "considered
 * six, took one" is the fact worth reading and "took one" is not.
 */
function headline(g: DecisionGroup): string {
  const took = g.entered.length;
  const refused = g.skipped.length;
  const managed = g.managed.length;
  const parts: string[] = [];
  if (took > 0) parts.push(`entered ${took}`);
  if (managed > 0) parts.push(`managed ${managed}`);
  if (refused > 0) parts.push(`refused ${refused}`);
  if (parts.length === 0) return "Nothing to do";
  const total = took + refused + managed;
  return `Considered ${total} — ${parts.join(", ")}`;
}
