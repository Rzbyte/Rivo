"use client";

// Live Event Contract intelligence.
//
// One card per tradable leg, each carrying what the venue shows plus the thing
// it cannot: whether prices like this one have historically meant what they
// said. Nothing here is an instruction — a card can say OVERCONFIDENT and that
// is a description of the settled record, not advice.

import { useEffect, useState } from "react";
import { useLive, ago } from "@/lib/live";
import { Nav } from "@/components/Nav";
import { ASSESSMENT_LABEL, ASSESSMENT_TONE, type AssessmentCode } from "@rivo/intel/assessment.js";
import { tenorLabel } from "@rivo/core/venue.js";

interface Card {
  marketId: string; asset: string; leg: string; intervalSec: number;
  expiry: number; secondsLeft: number;
  price: number | null; bid: number | null; ask: number | null;
  spread: number | null; depth: number;
  reference: number | null; gap: number | null;
  historical: {
    realized: number; windows: number; lo95: number; hi95: number; thin: boolean;
    cohortLabel: string; fellBack: boolean;
    bucket: { lo: number; hi: number };
    from: number | null; to: number | null;
  } | null;
  assessment: { code: AssessmentCode; detail: string };
}
interface Payload {
  at: number; cards: Card[];
  unpriced: { marketId: string; reason: string }[];
  calibration: { windows: number; from: number; to: number; basis: string } | null;
  cohorts?: number;
  error?: string;
}

const day = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);
const pct = (x: number | null, d = 1) => (x === null ? "—" : `${(x * 100).toFixed(d)}%`);

function countdown(s: number): string {
  if (s <= 0) return "settling";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  // Seconds stay visible under an hour, because that is the window where a
  // person is actually watching one tick down.
  return h > 0
    ? `${h}h ${String(m).padStart(2, "0")}m ${String(sec).padStart(2, "0")}s`
    : `${m}:${String(sec).padStart(2, "0")}`;
}

/**
 * A clock that ticks, rather than a number the server computed.
 *
 * The countdown used to render `secondsLeft` straight from the payload, so it
 * moved once per poll — ten seconds at a time, and up to eighteen behind, since
 * the markets endpoint caches for eight. On a fifteen-minute contract that is
 * the difference between a live venue and a screenshot of one.
 *
 * `expiry` is an absolute timestamp and was already on every card, so the fix is
 * to count from it locally and let the poll do what it is for: refreshing
 * prices, not the clock.
 */
function useNow(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    // Align to the next whole second so every card turns over together. A timer
    // started on mount drifts against the wall clock and the row above it.
    let interval: ReturnType<typeof setInterval>;
    const align = setTimeout(() => {
      setNow(Math.floor(Date.now() / 1000));
      interval = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1_000);
    }, 1_000 - (Date.now() % 1_000));
    return () => {
      clearTimeout(align);
      if (interval) clearInterval(interval);
    };
  }, []);
  return now;
}

export default function Markets() {
  const now = useNow();
  // Five seconds against an eight-second server cache: the poll is never the
  // thing making it stale, and the clock above ticks regardless.
  const { data, error, updatedAt } = useLive<Payload>("/api/markets", 5_000);

  return (
    <>
      <Nav />
      <main className="wrap" style={{ paddingTop: 26, paddingBottom: 72 }}>
        <span className="label">Markets</span>
        <h1 style={{ maxWidth: "18ch", marginTop: 8 }}>What does this probability mean?</h1>
        <p className="lede">
          Every live DreamDEX Event Contract, priced against what comparable contracts actually did after
          they settled. Descriptions, not instructions — no wallet needed to read any of it.
        </p>

        {error && <div className="banner bad" style={{ marginTop: 20 }}>{error}</div>}
        {!data && !error && <p className="muted" style={{ marginTop: 20 }}>Reading the venue…</p>}

        {data && (
          <>
            <div className="sec-head">
              <h2>{data.cards.length} live legs</h2>
              <span className="hint">
                {data.calibration
                  ? `${data.calibration.windows.toLocaleString()} settled windows across ${data.cohorts ?? 1} cohorts`
                  : "no calibration computed yet — assessments will say so"}
                {" · prices "}
                {ago(updatedAt, now * 1000)}
              </span>
            </div>

            <div className="grid cols-2">
              {data.cards.map((c) => (
                <MarketCard key={`${c.marketId}-${c.leg}`} c={c} now={now} />
              ))}
            </div>

            {data.unpriced.length > 0 && (
              <>
                <div className="sec-head">
                  <h2>Not priced</h2>
                  <span className="hint">shown rather than dropped</span>
                </div>
                <div className="panel">
                  {data.unpriced.map((u) => (
                    <div key={u.marketId} className="spread" style={{ padding: "6px 0", borderBottom: "1px solid var(--line)" }}>
                      <span className="mono faint" style={{ fontSize: 12 }}>{u.marketId.slice(0, 14)}…</span>
                      <span className="muted" style={{ fontSize: 13 }}>{u.reason}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </main>
    </>
  );
}

function MarketCard({ c, now }: { c: Card; now: number }) {
  const code = c.assessment.code;
  const tone = ASSESSMENT_TONE[code];
  const left = c.expiry - now;
  const h = c.historical;
  const gap = c.price !== null && h ? h.realized - c.price : null;

  return (
    <div className="panel">
      <div className="spread" style={{ marginBottom: 12 }}>
        <strong className="mono" style={{ fontSize: 14, letterSpacing: ".01em" }}>
          {c.asset} {c.leg} · {tenorLabel(c.intervalSec)}
        </strong>
        <span className="mono faint" style={{ fontSize: 12, whiteSpace: "nowrap" }}>{countdown(left)} left</span>
      </div>

      {/* The one comparison the card exists to make, at a size you read rather
          than parse. Everything below it is supporting detail. */}
      <div className="compare">
        <span className="big">{pct(c.price)}</span>
        <span className={`gap ${gap === null ? "faint" : Math.abs(gap) <= 0.03 ? "muted" : gap > 0 ? "pos" : "neg"}`}>
          {gap === null ? "—" : `${gap >= 0 ? "+" : ""}${(gap * 100).toFixed(1)}%`}
        </span>
        <span className="vs" style={{ gridColumn: "1 / -1" }}>
          asked by DreamDEX{h ? ` · comparable contracts settled true ${pct(h.realized)}` : " · nothing comparable has settled yet"}
        </span>
      </div>

      {c.price !== null && h && <Scale asked={c.price} settled={h.realized} thin={h.thin} />}

      <div className="kv">
        <div><span className="k">Rivo</span><span className="v">{pct(c.reference)}</span></div>
        <div><span className="k">Spread</span><span className="v">{pct(c.spread, 2)}</span></div>
        <div><span className="k">Depth</span><span className="v">{c.depth.toFixed(1)} sh</span></div>
        <div><span className="k">Sample</span><span className="v">{h ? `${h.windows}w` : "none"}</span></div>
      </div>

      <div className="row" style={{ marginTop: 12, gap: 8 }}>
        <span className={`verdict ${tone === "claim" ? "claim" : tone === "caution" ? "caution" : code === "WELL_CALIBRATED" ? "good" : ""}`}>
          {ASSESSMENT_LABEL[code]}
        </span>
      </div>
      <p className="hint" style={{ marginTop: 8, marginBottom: 0 }}>{c.assessment.detail}</p>

      {/* Everything needed to check the number, in the order a sceptic asks for
          it: which contracts, in which price band, over how many settled
          windows, between which dates, with what uncertainty, and whether the
          most specific comparable set was the one that answered.

          Without the band, "settled true 3.3%" sits beside a price of 0.02 and
          a reader cannot tell whether 3.3% describes contracts quoted near 0.02
          or the cohort as a whole. It is the former. Without the dates, nothing
          about the claim can be dated. */}
      {h && (
        <div className="hint" style={{ marginTop: 8, marginBottom: 0, lineHeight: 1.6 }}>
          <div>
            Cohort <strong>{h.cohortLabel}</strong>
            {h.fellBack && (
              <span className="warn-text"> — widened, this market&rsquo;s own cohort had too few settled windows</span>
            )}
          </div>
          <div>
            Price band {pct(h.bucket.lo, 0)}–{pct(h.bucket.hi, 0)} · {h.windows} settled window
            {h.windows === 1 ? "" : "s"} · 95% CI {pct(h.lo95)}–{pct(h.hi95)}
          </div>
          {h.from !== null && h.to !== null && (
            <div>
              Measured {day(h.from)} → {day(h.to)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Asked and settled on one 0–100% scale.
 *
 * A bar per number would invite comparing one card against the next; this
 * compares the pair, which is the only comparison the card is about. The band
 * between them is the gap made visible — two numbers a reader would otherwise
 * have to subtract.
 */
function Scale({ asked, settled, thin }: { asked: number; settled: number; thin: boolean }) {
  const lo = Math.min(asked, settled) * 100;
  const hi = Math.max(asked, settled) * 100;
  return (
    <div className="scale" aria-hidden="true">
      <span className="rule" />
      <span className="span" style={{ left: `${lo}%`, width: `${hi - lo}%` }} />
      <span className="asked" style={{ left: `${asked * 100}%` }} title={`asked ${(asked * 100).toFixed(1)}%`} />
      <span className={`settled ${thin ? "thin" : ""}`} style={{ left: `${settled * 100}%` }} title={`settled ${(settled * 100).toFixed(1)}%`} />
    </div>
  );
}
