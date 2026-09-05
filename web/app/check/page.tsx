"use client";

// The front door, for somebody who is not going to read a table.
//
// Every other surface in this product is built for a reader who wants the
// cohort, the interval and the date range on screen at once. That reader
// exists and Markets is theirs. This one is for the person who is about to
// accept a price on DreamDEX and has one question — *is this price fair?* —
// and roughly ten seconds of patience for the answer.
//
// So: one contract at a time, two numbers, one sentence. The rigour is not
// removed, it is folded — every claim here can be expanded into the sample size
// and interval that produced it, and the expansion is one tap away rather than
// in the reader's face. Nothing on this page is hidden that a reader could be
// misled by leaving folded.
//
// WHAT THIS PAGE REFUSES TO DO.
//
// There is no buy button and no signer anywhere near it. A verdict about
// whether a price band has historically paid, sitting next to a control that
// acts on it, is a recommendation however the copy is worded — and this
// repository's whole argument is that a measurement which quietly becomes
// advice has stopped being a measurement. The venue is one click away and that
// click is the reader's, taken with the number in hand.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useLive } from "@/lib/live";
import { Nav } from "@/components/Nav";
import { RULES, type AssessmentCode } from "@rivo/intel/assessment.js";
import { tenorLabel } from "@rivo/core/venue.js";

interface Card {
  marketId: string;
  asset: string;
  leg: string;
  intervalSec: number;
  expiry: number;
  secondsLeft: number;
  price: number | null;
  bid: number | null;
  ask: number | null;
  spread: number | null;
  depth: number;
  reference: number | null;
  gap: number | null;
  historical: {
    realized: number;
    windows: number;
    lo95: number;
    hi95: number;
    thin: boolean;
    cohortLabel: string;
    fellBack: boolean;
    bucket: { lo: number; hi: number };
    from: number | null;
    to: number | null;
  } | null;
  assessment: { code: AssessmentCode; detail: string };
}

interface Payload {
  at: number;
  cards: Card[];
  calibration: { windows: number; from: number; to: number } | null;
  error?: string;
}

const pct = (x: number | null, d = 0) => (x === null ? "—" : `${(x * 100).toFixed(d)}%`);
const day = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);

function countdown(s: number): string {
  if (s <= 0) return "settling now";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m left`;
  if (m > 0) return `${m}m ${String(s % 60).padStart(2, "0")}s left`;
  return `${s}s left`;
}

/**
 * The question the contract actually asks, in words a person uses.
 *
 * "BTC UP 15m" is venue shorthand. What it means is whether one asset finishes
 * one window above where it started, and that is what goes at the top.
 */
function question(c: Card): string {
  const direction = c.leg === "UP" ? "higher" : "lower";
  return `Will ${c.asset} close ${direction} than it opened?`;
}

interface Verdict {
  /** The line in the largest type on the page. */
  headline: string;
  /** One sentence under it. Never an instruction. */
  detail: string;
  tone: "good" | "under" | "over" | "caveat";
}

/**
 * The verdict, derived from the same assessment the dense surface renders.
 *
 * The mapping is deliberately one-to-one with `AssessmentCode` rather than a
 * second opinion computed here — two surfaces that describe the same contract
 * differently is exactly the failure this product was built to catch, and it
 * would be the more embarrassing one for happening inside it.
 *
 * A caveat outranks a claim. If the sample is thin, the book is wide or the
 * depth is not there, that is the answer — the calibration comparison is not
 * shown as the headline underneath a warning, because a reader takes the
 * biggest number on the screen and leaves.
 */
function verdict(c: Card): Verdict {
  const h = c.historical;
  const quoted = c.price;

  switch (c.assessment.code) {
    case "INSUFFICIENT_SAMPLE":
      return {
        headline: "Not enough history to say",
        detail:
          h === null
            ? "No comparable contract has settled at this price yet. The honest answer is that nobody knows."
            : `Only ${h.windows} comparable ${h.windows === 1 ? "contract has" : "contracts have"} settled at this price — under the ${RULES.minWindows} this product requires before it will call anything.`,
        tone: "caveat",
      };
    case "LOW_LIQUIDITY":
      return {
        headline: "Almost nothing is on offer",
        detail: `${c.depth.toFixed(0)} shares are available at this price. Whether it is fair matters less than whether you could get filled.`,
        tone: "caveat",
      };
    case "HIGH_SPREAD":
      return {
        headline: "The spread costs more than the edge",
        detail: `Buying and selling back immediately would cost ${pct(c.spread, 1)}. That gap is the dominant fact about this price, whatever the history says.`,
        tone: "caveat",
      };
    case "LARGE_DISAGREEMENT":
      return {
        headline: "Rivo's model disagrees sharply",
        detail: `The book asks ${pct(quoted)} and Rivo's own model says ${pct(c.reference)}. A disagreement this size is worth knowing about — and Rivo's model is one this product has already refused to trade.`,
        tone: "caveat",
      };
    case "OVERCONFIDENT":
      return {
        headline: "The book is asking too much",
        detail: `Prices in this band settled true ${pct(h?.realized ?? null)} of the time. You are being asked for ${pct(quoted)}.`,
        tone: "over",
      };
    case "UNDERCONFIDENT":
      return {
        headline: "The book is asking too little",
        detail: `Prices in this band settled true ${pct(h?.realized ?? null)} of the time. You are being asked for ${pct(quoted)}.`,
        tone: "under",
      };
    case "WELL_CALIBRATED":
    default:
      return {
        headline: "This price is honest",
        detail: `Contracts priced near ${pct(quoted)} settled true ${pct(h?.realized ?? null)} of the time. The price is doing its job.`,
        tone: "good",
      };
  }
}

const TONE_COLOR: Record<Verdict["tone"], string> = {
  good: "var(--pos)",
  under: "var(--accent)",
  over: "var(--neg)",
  caveat: "var(--warn)",
};

export default function Check() {
  const live = useLive<Payload>("/api/markets", 15_000);
  const [i, setI] = useState(0);
  const [open, setOpen] = useState(false);

  const cards = live.data?.cards ?? [];
  // A contract that expires while somebody is looking at it must not leave them
  // reading a stale verdict, and the index has to survive the list shrinking.
  const n = cards.length;
  const card = n > 0 ? cards[Math.min(i, n - 1)]! : null;

  const move = useCallback(
    (by: number) => {
      if (n === 0) return;
      setOpen(false);
      setI((prev) => (prev + by + n) % n);
    },
    [n],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "ArrowRight") move(1);
      if (e.key === "ArrowLeft") move(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [move]);

  const v = card ? verdict(card) : null;
  const cal = live.data?.calibration ?? null;

  return (
    <>
      <Nav />
      <main className="wrap" style={{ paddingTop: 28, paddingBottom: 72, maxWidth: 720 }}>
        <span className="label">Check a price</span>
        <h1 style={{ marginTop: 8, maxWidth: "20ch" }}>Is this price fair?</h1>
        <p className="lede" style={{ maxWidth: "56ch" }}>
          One live DreamDEX contract at a time, next to how often contracts priced like it actually
          settled true. No wallet, no account, and nothing here tells you what to do.
        </p>

        {live.error && <p className="muted">Could not reach the venue: {live.error}</p>}
        {!live.error && n === 0 && (
          <p className="muted" style={{ marginTop: 28 }}>
            {live.loading ? "Reading the venue…" : "No contract is open for trading right now."}
          </p>
        )}

        {card && v && (
          <section
            style={{
              marginTop: 28,
              padding: "28px 24px",
              border: "1px solid var(--line-2)",
              borderRadius: "calc(var(--r) * 1.5)",
              background: "var(--panel)",
              boxShadow: "var(--shadow)",
            }}
          >
            <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
              <span className="label">
                {card.asset} · {tenorLabel(card.intervalSec)}
              </span>
              <span className="mono faint" style={{ fontSize: 13 }}>
                {countdown(card.secondsLeft)}
              </span>
            </div>

            <h2 style={{ marginTop: 10, fontSize: 26, lineHeight: 1.25 }}>{question(card)}</h2>

            {/* The two numbers the whole page exists to put beside each other. */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 12,
                marginTop: 24,
                textAlign: "center",
              }}
            >
              <div>
                <div className="label">The book asks</div>
                <div className="mono" style={{ fontSize: 44, fontWeight: 700, lineHeight: 1.1 }}>
                  {pct(card.price)}
                </div>
              </div>
              <div>
                <div className="label">History settled</div>
                <div
                  className="mono"
                  style={{ fontSize: 44, fontWeight: 700, lineHeight: 1.1, color: TONE_COLOR[v.tone] }}
                >
                  {card.historical ? pct(card.historical.realized) : "—"}
                </div>
              </div>
            </div>

            <div
              style={{
                marginTop: 24,
                paddingTop: 20,
                borderTop: "1px solid var(--line)",
              }}
            >
              <div style={{ fontSize: 20, fontWeight: 650, color: TONE_COLOR[v.tone] }}>{v.headline}</div>
              <p className="muted" style={{ marginTop: 8, marginBottom: 0 }}>
                {v.detail}
              </p>
            </div>

            <button
              type="button"
              className="btn"
              style={{ marginTop: 20 }}
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
            >
              {open ? "Hide the working" : "Show the working"}
            </button>

            {open && (
              <div className="scroll" style={{ marginTop: 16 }}>
                {card.historical ? (
                  <table>
                    <tbody>
                      <tr>
                        <td className="muted">Compared against</td>
                        <td className="mono">{card.historical.cohortLabel}</td>
                      </tr>
                      <tr>
                        <td className="muted">Price band</td>
                        <td className="mono">
                          {pct(card.historical.bucket.lo)}–{pct(card.historical.bucket.hi)}
                        </td>
                      </tr>
                      <tr>
                        <td className="muted">Settled contracts in it</td>
                        <td className="mono">{card.historical.windows}</td>
                      </tr>
                      <tr>
                        <td className="muted">95% interval</td>
                        <td className="mono">
                          {pct(card.historical.lo95, 1)} – {pct(card.historical.hi95, 1)}
                        </td>
                      </tr>
                      <tr>
                        <td className="muted">Measured over</td>
                        <td className="mono">
                          {card.historical.from && card.historical.to
                            ? `${day(card.historical.from)} → ${day(card.historical.to)}`
                            : "—"}
                        </td>
                      </tr>
                      {card.historical.fellBack && (
                        <tr>
                          <td className="muted">Widened</td>
                          <td>
                            This exact cohort had too few settled contracts, so the comparison widened
                            and says so rather than quoting a number from a handful.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                ) : (
                  <p className="muted">
                    No comparable set has settled yet, so there is nothing to compare this price
                    against. That is the answer rather than a missing number.
                  </p>
                )}
                <p className="faint" style={{ marginTop: 12, fontSize: 13 }}>
                  A settled contract is one independent observation — not one per fill, because forty
                  fills inside one window share one outcome. <Link href="/calibration">The method</Link>.
                </p>
              </div>
            )}
          </section>
        )}

        {n > 1 && (
          <div className="row" style={{ marginTop: 20, justifyContent: "space-between" }}>
            <button type="button" className="btn" onClick={() => move(-1)}>
              ← Previous
            </button>
            <span className="faint mono" style={{ fontSize: 13 }}>
              {Math.min(i, n - 1) + 1} of {n} open
            </span>
            <button type="button" className="btn primary" onClick={() => move(1)}>
              Next contract →
            </button>
          </div>
        )}

        <p className="faint" style={{ marginTop: 32, fontSize: 13, lineHeight: 1.6 }}>
          Every figure here is measured against contracts that have already settled
          {cal ? ` — ${cal.windows.toLocaleString("en-US")} of them, ${day(cal.from)} → ${day(cal.to)}` : ""}. It
          describes the record, not the future, and it is not advice. Rivo does not take a position on
          this contract and has refused its own model the right to.{" "}
          <Link href="/agents">Why</Link>.
        </p>

        <p className="faint" style={{ marginTop: 14, fontSize: 13 }}>
          Want every open contract at once, with the numbers unfolded?{" "}
          <Link href="/markets">Markets</Link>.
        </p>
      </main>
    </>
  );
}
