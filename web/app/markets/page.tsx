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
  const tone = ASSESSMENT_TONE[c.assessment.code];
  // Counted from the absolute expiry, not from the payload's snapshot.
  const left = c.expiry - now;
  return (
    <div className="panel">
      <div className="spread" style={{ marginBottom: 10 }}>
        <div>
          <strong className="mono" style={{ fontSize: 14 }}>
            {c.asset} {c.leg} · {tenorLabel(c.intervalSec)}
          </strong>
        </div>
        <span className="mono faint" style={{ fontSize: 12 }}>{countdown(left)} left</span>
      </div>

      <div className="grid cols-2" style={{ gap: 8, marginBottom: 10 }}>
        <Row k="DreamDEX asks" v={pct(c.price)} strong />
        <Row k="Settled true" v={c.historical ? pct(c.historical.realized) : "—"} />
        <Row k="Rivo reference" v={pct(c.reference)} />
        <Row k="Spread" v={pct(c.spread, 2)} />
        <Row k="Depth at reference" v={`${c.depth.toFixed(1)} sh`} />
        <Row k="Sample" v={c.historical ? `${c.historical.windows} windows` : "none"} />
      </div>

      {/* Where the historical number came from. Without this "61%" is a figure
          with no population attached, and the reader cannot check it. */}
      {c.historical && (
        <p className="hint" style={{ marginTop: 0, marginBottom: 8 }}>
          Compared against <strong>{c.historical.cohortLabel}</strong>
          {c.historical.fellBack && " — a wider set, because this market's own cohort had too few settled windows"}
          {c.historical.thin && " · sample below the floor, so no claim is made"}
        </p>
      )}

      <div
        className={`banner ${tone === "claim" ? "warn" : tone === "caution" ? "bad" : ""}`}
        style={{ marginBottom: 0, fontSize: 12.5 }}
      >
        <strong>{ASSESSMENT_LABEL[c.assessment.code]}.</strong> {c.assessment.detail}
      </div>
    </div>
  );
}

function Row({ k, v, strong = false }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className="spread" style={{ fontSize: 13 }}>
      <span className="label" style={{ letterSpacing: ".06em" }}>{k}</span>
      <span className="mono" style={{ fontWeight: strong ? 640 : 400 }}>{v}</span>
    </div>
  );
}
