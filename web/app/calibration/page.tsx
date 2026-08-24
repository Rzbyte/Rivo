"use client";

// The hero feature: does a quoted probability mean what it says?
//
// Everything on this page is a measurement with its sample size attached. That
// is the whole discipline — a calibration table without window counts is a
// picture, and a picture is exactly what nobody should trust about somebody
// else's money.

import { useEffect, useState } from "react";
import { Nav } from "@/components/Nav";

interface Bucket {
  lo: number; hi: number; n: number; windows: number;
  quoted: number; realized: number; gap: number;
  se: number; lo95: number; hi95: number; thin: boolean;
}
interface Report {
  buckets: Bucket[]; n: number; windows: number; from: number; to: number;
  basis: string; executableOnly: boolean; minWindows: number;
  brier: number; brierBase: number; skill: number; baseRate: number;
}
interface Payload {
  report: Report | null; computedAt?: string; note?: string;
  observations?: number; windows?: number; skill?: number; network?: string;
}

const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;
const signed = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
const day = (s: number) => new Date(s * 1000).toISOString().slice(0, 10);

export default function Calibration() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/calibration")
      .then((r) => r.json())
      .then(setData)
      .catch(() => setError("could not load the calibration report"));
  }, []);

  const r = data?.report ?? null;

  return (
    <>
      <Nav />
      <main className="wrap" style={{ paddingTop: 26, paddingBottom: 72 }}>
        <span className="label">Calibration</span>
        <h1 style={{ maxWidth: "16ch", marginTop: 8 }}>Is 67% actually 67%?</h1>
        <p className="lede">
          DreamDEX quotes a probability. Nothing on the venue tells you whether contracts that quoted 67%
          went on to settle true about 67% of the time — which is the only question a price of 0.67 raises.
          This measures it against contracts that have already settled.
        </p>

        {error && <div className="banner bad" style={{ marginTop: 20 }}>{error}</div>}
        {!data && !error && <p className="muted" style={{ marginTop: 20 }}>Measuring…</p>}
        {data && !r && (
          <div className="banner warn" style={{ marginTop: 20 }}>
            {data.note ?? "No calibration has been computed on this deployment yet."} Run{" "}
            <span className="mono">npm run calibration -- --store</span> to produce one.
          </div>
        )}

        {r && (
          <>
            <section className="grid cols-4" style={{ marginTop: 24 }}>
              <Stat k="Settled windows" v={r.windows.toLocaleString()} s="Independent outcomes behind every number here." />
              <Stat k="Brier score" v={r.brier.toFixed(4)} s={`Against ${r.brierBase.toFixed(4)} for always quoting the base rate.`} />
              <Stat k="Skill" v={pct(r.skill)} s="How much the venue's prices beat that baseline." />
              <Stat k="Base rate" v={pct(r.baseRate)} s={`${day(r.from)} to ${day(r.to)}.`} />
            </section>

            <div className="sec-head">
              <h2>Quoted against settled</h2>
              <span className="hint">
                {r.basis === "window" ? "one observation per settled contract" : "one per fill · correlated"}
              </span>
            </div>

            <div className="panel">
              <div className="scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Quoted</th>
                      <th className="n">Windows</th>
                      <th className="n">Settled true</th>
                      <th>95% interval</th>
                      <th className="n">Gap</th>
                      <th style={{ width: "24%" }}>Quoted vs settled</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.buckets.map((b) => (
                      <tr key={b.lo}>
                        <td className="mono">
                          {(b.lo * 100).toFixed(0)}–{(b.hi * 100).toFixed(0)}%
                        </td>
                        <td className="n">{b.windows}</td>
                        <td className="n">{b.thin ? <span className="faint">{pct(b.realized)}</span> : pct(b.realized)}</td>
                        <td className="mono faint" style={{ fontSize: 12 }}>
                          {pct(b.lo95, 0)} – {pct(b.hi95, 0)}
                        </td>
                        <td className={`n ${b.thin ? "faint" : Math.abs(b.gap) <= 0.03 ? "" : b.gap > 0 ? "pos" : "neg"}`}>
                          {b.thin ? "—" : signed(b.gap)}
                        </td>
                        <td>
                          {/* Two marks on one scale: what was asked, and what happened.
                              A bar per row would compare rows; this compares the pair,
                              which is the only comparison the table is about. */}
                          <Pair quoted={b.quoted} realized={b.realized} thin={b.thin} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="hint" style={{ marginTop: 12, marginBottom: 0 }}>
                Buckets under {r.minWindows} settled windows are greyed and make no claim. A gap is only
                shown where the sample supports one.
              </p>
            </div>

            <div className="sec-head">
              <h2>How this is measured</h2>
            </div>
            <div className="panel">
              <div className="defs">
                <Def t="One observation" d={`One settled contract, sampled at a moment a trade actually happened. ${r.windows.toLocaleString()} of them.`} />
                <Def
                  t="Why not one per fill"
                  d="Every fill inside one settled window shares one outcome. Forty rows from a window that resolved UP are forty copies of one coin flip, and counting them as forty observations shrinks every interval by roughly the square root of the ratio. The intervals here come from resampling windows, not rows."
                />
                <Def
                  t="Which price"
                  d={r.executableOnly
                    ? "The executable side only. A fill proves one direction was takeable at that price; calibrating on a midpoint measures a price nobody could trade."
                    : "Both legs of every fill."}
                />
                <Def t="Outcome" d="Whether that leg paid out at settlement, read from the venue's own finalised markets. Voided markets are excluded." />
                <Def t="Interval" d="95%, from a bootstrap that resamples settled windows with replacement — so the uncertainty reflects the thing that actually varies." />
              </div>
              <p className="hint" style={{ marginTop: 14, marginBottom: 0 }}>
                Historical calibration describes what has happened. It does not predict what will.
              </p>
            </div>
          </>
        )}
      </main>
    </>
  );
}

function Stat({ k, v, s }: { k: string; v: string; s: string }) {
  return (
    <div className="panel stat">
      <span className="label">{k}</span>
      <span className="value">{v}</span>
      <span className="sub">{s}</span>
    </div>
  );
}

function Def({ t, d }: { t: string; d: string }) {
  return (
    <div>
      <div className="t">{t}</div>
      <div className="d">{d}</div>
    </div>
  );
}

/** Quoted and realized on one 0–100% scale, so the reader compares the pair. */
function Pair({ quoted, realized, thin }: { quoted: number; realized: number; thin: boolean }) {
  return (
    <div style={{ position: "relative", height: 16 }} aria-hidden="true">
      <div style={{ position: "absolute", inset: "7px 0 auto 0", height: 2, background: "var(--line)" }} />
      <span
        title={`quoted ${(quoted * 100).toFixed(1)}%`}
        style={{
          position: "absolute", left: `${quoted * 100}%`, top: 2, width: 2, height: 12,
          background: "var(--faint)", transform: "translateX(-1px)",
        }}
      />
      <span
        title={`settled ${(realized * 100).toFixed(1)}%`}
        style={{
          position: "absolute", left: `${realized * 100}%`, top: 4, width: 8, height: 8,
          borderRadius: "50%", background: thin ? "var(--line-2)" : "var(--accent)",
          transform: "translateX(-4px)",
        }}
      />
    </div>
  );
}
