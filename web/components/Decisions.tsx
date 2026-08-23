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
// entries, they carry the constraint that bound them, and where the constraint
// was correlated exposure they carry the arithmetic: what the portfolio already
// held in that underlying, what the budget was, and therefore what taking this
// leg as well would have meant. That is the difference between "Rivo says no"
// and "here is why no is right".

import type { DecisionGroup } from "@rivo/db/view.js";
import type { DecisionRecord } from "@rivo/runtime/state.js";
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

          <Correlated group={g} />

          {g.bindings.length > 0 && (
            <div className="row" style={{ marginBottom: 8 }}>
              {g.bindings.slice(0, 4).map((b) => (
                <span key={b.binding} className="pill" title={`${b.count} leg(s) refused for this reason`}>
                  {b.binding} ×{b.count}
                </span>
              ))}
            </div>
          )}

          <Legs group={g} />
        </div>
      ))}
    </>
  );
}

/**
 * The legs, with the repetitive ones folded away.
 *
 * A cycle considers sixteen legs and most passes refuse twelve of them for the
 * identical reason — a window inside its expiry headroom, an edge below the
 * floor. Rendering each as a full-width row with its own reason bar turned every
 * cycle into a wall in which the one interesting decision was indistinguishable
 * from the twelve boring ones.
 *
 * So a leg is shown in full when it is worth reading: anything Rivo acted on,
 * and any refusal where the edge was POSITIVE — which is the case the whole
 * product is about, a good opportunity declined for a portfolio reason. The rest
 * collapse into one line that can be opened.
 */
function Legs({ group }: { group: DecisionGroup }) {
  const all = [...group.entered, ...group.managed, ...group.skipped];
  const notable = all.filter((d) => d.action !== "SKIP" || (d.edge ?? 0) > 0);
  const routine = all.filter((d) => !notable.includes(d));
  return (
    <>
      {notable.map((d, i) => (
        <Card key={`n-${d.marketId}-${d.leg}-${i}`} d={d} />
      ))}
      {routine.length > 0 && (
        <details style={{ marginTop: notable.length > 0 ? 8 : 0 }}>
          <summary className="faint" style={{ cursor: "pointer", fontSize: 12.5, padding: "6px 0" }}>
            {routine.length} more refused with no edge to give up
          </summary>
          <div style={{ marginTop: 4 }}>
            {routine.map((d, i) => (
              <Card key={`r-${d.marketId}-${d.leg}-${i}`} d={d} />
            ))}
          </div>
        </details>
      )}
    </>
  );
}

/** One decision, with everything that produced it. */
function Card({ d }: { d: DecisionRecord }) {
  const taken = d.action !== "SKIP";
  const e = d.exposure;
  return (
    <div className={`decision ${taken ? "taken" : "refused"}`}>
      <strong className="mono">
        {d.asset} {d.leg} · {tenorLabel(d.intervalSec)}
      </strong>
      <span className="num">
        {Number.isFinite(d.fair) && (
          <>
            <span className="faint">Rivo </span>
            {(d.fair * 100).toFixed(1)}%
          </>
        )}
        {d.ask !== null && (
          <>
            <span className="faint"> · market </span>
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

      <div className="why" title={d.binding}>
        <strong>{d.action}</strong>
        {d.shares > 0 && (
          <span className="mono">
            {" "}
            {d.shares.toFixed(2)} shares · {d.cost.toFixed(2)}
          </span>
        )}{" "}
        — {shorten(d.binding)}
      </div>

      {e && <ExposureLine asset={d.asset} e={e} taken={taken} />}
    </div>
  );
}

/**
 * A reason, cut to something readable.
 *
 * Most bindings are a phrase. A few are whatever the chain library threw, and
 * one of those ran to six lines of encoded calldata and a documentation link —
 * inside a card, in a list of sixteen. The full text stays in the title
 * attribute and in the database; what is rendered is the part a person reads.
 */
function shorten(binding: string, max = 150): string {
  const firstSentence = binding.split(/(?<=\.)\s/)[0] ?? binding;
  const text = firstSentence.length < binding.length && firstSentence.length > 40 ? firstSentence : binding;
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()}…`;
}

/**
 * The arithmetic behind a refusal.
 *
 * Rendered as a bar with a marker at the budget, because "1.80 of 2.50" is a
 * sentence and a bar is a glance. For a refusal `after` equals `before` by
 * definition, and saying so out loud — "unchanged" — is what turns a skipped row
 * from an absence into a decision.
 */
function ExposureLine({
  asset,
  e,
  taken,
}: {
  asset: string;
  e: NonNullable<DecisionRecord["exposure"]>;
  taken: boolean;
}) {
  const cap = Math.max(1e-9, e.cap);
  const usedBefore = Math.min(1, Math.abs(e.before) / cap);
  const usedAfter = Math.min(1, Math.abs(e.after) / cap);
  const moved = Math.abs(e.after - e.before) > 1e-9;
  return (
    <div className="why" style={{ borderLeftColor: "var(--line-2)", background: "transparent", paddingLeft: 10 }}>
      <span className="label" style={{ display: "block", marginBottom: 3 }}>
        {asset} correlated exposure
      </span>
      <div className="meter" style={{ marginTop: 0 }}>
        <span className={usedAfter > 0.95 ? "hot" : ""} style={{ width: `${usedAfter * 100}%` }} />
      </div>
      <span className="mono" style={{ fontSize: 12 }}>
        {e.before >= 0 ? "+" : ""}
        {e.before.toFixed(2)}
        {moved ? (
          <>
            {" → "}
            <strong>
              {e.after >= 0 ? "+" : ""}
              {e.after.toFixed(2)}
            </strong>
          </>
        ) : (
          <span className="faint"> unchanged</span>
        )}
        <span className="faint">
          {" "}
          of ±{e.cap.toFixed(2)} per 1% move · {Math.round(usedBefore * 100)}%
          {moved ? ` → ${Math.round(usedAfter * 100)}%` : ""} used
        </span>
      </span>
      {!taken && usedBefore > 0.95 && (
        <div style={{ fontSize: 12.5, marginTop: 3 }}>
          The budget for {asset} was already spent by another tenor. Taking this leg as well would have been the
          same directional view, held twice.
        </div>
      )}
    </div>
  );
}

/**
 * The correlated case, named when it happens.
 *
 * The product's whole argument in one line, and only shown when the cycle
 * actually contains it: two or more positive-edge legs on one underlying, of
 * which some were refused. Inventing this banner on a cycle that did not do it
 * would be the easiest and worst thing to fake.
 */
function Correlated({ group }: { group: DecisionGroup }) {
  const all = [...group.entered, ...group.skipped];
  for (const asset of ["BTC", "ETH"]) {
    const positive = all.filter((d) => d.asset === asset && (d.edge ?? 0) > 0);
    if (positive.length < 2) continue;
    const took = positive.filter((d) => d.action !== "SKIP");
    // Only refusals the BUDGET actually made. This used to count every refusal,
    // and so claimed "the BTC budget was already committed" on a cycle where the
    // legs had failed for an unrelated reason — a signing error, in the run that
    // caught it. Asserting the product's own argument on evidence that does not
    // support it is worse than not asserting it.
    const refused = positive.filter((d) => d.action === "SKIP" && /delta budget/i.test(d.binding));
    if (refused.length === 0) continue;
    const best = took[0];
    return (
      <div className="banner good" style={{ marginBottom: 10 }}>
        <strong>
          {positive.length} {asset} windows had positive edge.
        </strong>{" "}
        {best
          ? `Rivo took ${tenorLabel(best.intervalSec)} and refused ${refused.length} other${refused.length === 1 ? "" : "s"} — they are the same directional view at a different tenor, and the portfolio only has one ${asset} budget.`
          : `Rivo took none of them — the ${asset} budget was already committed. A strategy scoring each market on its own would have bought all ${positive.length}.`}
      </div>
    );
  }
  return null;
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
