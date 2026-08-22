"use client";

// Capital and risk, in a user's terms.
//
// Three profiles do most of the work, because the honest answer to "what should
// my maximum correlated BTC delta be" is that almost nobody knows and the ones
// who do will open the advanced panel. What the profiles actually change is
// shown underneath in collateral rather than in fractions — "at most 12.50 in
// one position" is a sentence somebody can check against their own judgement;
// "maxPerPosition 0.25" is not.
//
// The Autopilot button is the last thing on the page and says exactly what
// granting permission means, including that it is revocable. That sentence is
// the most important text in the product.

import { useState } from "react";
import type { Balances } from "@/lib/balances";
import type { PortfolioView } from "@rivo/db/view.js";

const PROFILES = [
  { name: "conservative", title: "Conservative", blurb: "Smaller positions, more cash held back, only the clearest edges." },
  { name: "balanced", title: "Balanced", blurb: "The default. Half-Kelly sizing inside the full set of portfolio limits." },
  { name: "active", title: "Active", blurb: "More capital deployed and a lower edge threshold. More trades, more variance." },
] as const;

export function Configure({
  view,
  balances,
  busy,
  onSave,
  onEnable,
}: {
  view: PortfolioView;
  balances: Balances | null;
  busy: string | null;
  onSave: (patch: { capital?: number; profile?: string; overrides?: Record<string, unknown> }) => Promise<void>;
  onEnable: () => Promise<void>;
}) {
  const available = balances?.collateral ?? 0;
  const [capital, setCapital] = useState(String(view.capital));
  const [profile, setProfile] = useState<string>(view.profile);
  const [advanced, setAdvanced] = useState(false);
  const [overrides, setOverrides] = useState<Record<string, number>>({
    maxPerPosition: view.limits.perPositionCap / Math.max(1, view.capital),
    maxAssetDeltaPer1Pct: view.limits.assetDeltaCap / Math.max(1, view.capital),
    cashFloor: view.limits.cashFloor / Math.max(1, view.capital),
  });

  const amount = Number(capital);
  const valid = Number.isFinite(amount) && amount > 0;
  const overFunded = valid && amount > available && available > 0;
  const dirty = amount !== view.capital || profile !== view.profile;

  return (
    <>
      <div className="panel">
        <span className="label">Step 3</span>
        <h2 style={{ marginTop: 8 }}>How much, and how hard</h2>

        <div className="grid cols-2" style={{ marginTop: 12 }}>
          <div className="field">
            <label className="label" htmlFor="capital">
              Capital under management ({balances?.collateralSymbol ?? "collateral"})
            </label>
            <input
              id="capital"
              className="mono"
              inputMode="decimal"
              value={capital}
              onChange={(e) => setCapital(e.target.value)}
            />
            <div className="hint">
              {available > 0 ? `${available.toFixed(2)} in the wallet.` : "Wallet balance unknown."} Every risk
              limit below is a fraction of this number, not of the wallet — so funding more later does not
              silently raise them.
            </div>
            {overFunded && (
              <div className="hint warn">
                More than the wallet holds. Rivo will simply run out of collateral before it reaches this
                ceiling; it will not overdraw.
              </div>
            )}
          </div>

          <div className="field">
            <span className="label">Risk profile</span>
            {PROFILES.map((p) => (
              <label
                key={p.name}
                className="row"
                style={{
                  alignItems: "flex-start",
                  padding: "9px 11px",
                  border: `1px solid var(${profile === p.name ? "--accent" : "--line"})`,
                  background: profile === p.name ? "var(--accent-soft)" : "transparent",
                  borderRadius: "var(--r)",
                  marginBottom: 6,
                  cursor: "pointer",
                  flexWrap: "nowrap",
                }}
              >
                <input
                  type="radio"
                  name="profile"
                  checked={profile === p.name}
                  onChange={() => setProfile(p.name)}
                  style={{ width: "auto", marginTop: 4 }}
                />
                <span>
                  <strong>{p.title}</strong>
                  <br />
                  <span className="hint" style={{ marginTop: 0 }}>
                    {p.blurb}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className="panel" style={{ background: "var(--panel-2)", marginTop: 4 }}>
          <span className="label">What that means, in {balances?.collateralSymbol ?? "collateral"}</span>
          <div className="grid cols-4" style={{ marginTop: 8 }}>
            <Limit label="Most in one position" value={view.limits.perPositionCap} />
            <Limit label="Most deployed at once" value={view.limits.deployedCap} />
            <Limit label="Most BTC exposure per 1% move" value={view.limits.assetDeltaCap} />
            <Limit label="Cash never spent" value={view.limits.cashFloor} />
          </div>
          <p className="hint" style={{ marginTop: 10, marginBottom: 0 }}>
            Minimum edge before Rivo crosses a spread: {(view.limits.minEdge * 100).toFixed(1)}% · Kelly
            fraction ×{view.limits.kellyFraction}
          </p>
        </div>

        <div style={{ marginTop: 12 }}>
          <button className="link" onClick={() => setAdvanced((a) => !a)} aria-expanded={advanced}>
            {advanced ? "Hide" : "Show"} advanced limits
          </button>
          {advanced && (
            <div className="grid cols-3" style={{ marginTop: 10 }}>
              <Slider
                label="Max in one position"
                value={overrides.maxPerPosition ?? 0}
                onChange={(v) => setOverrides((o) => ({ ...o, maxPerPosition: v }))}
                capital={amount}
              />
              <Slider
                label="Max exposure per underlying"
                value={overrides.maxAssetDeltaPer1Pct ?? 0}
                onChange={(v) => setOverrides((o) => ({ ...o, maxAssetDeltaPer1Pct: v }))}
                capital={amount}
              />
              <Slider
                label="Cash floor"
                value={overrides.cashFloor ?? 0}
                onChange={(v) => setOverrides((o) => ({ ...o, cashFloor: v }))}
                capital={amount}
              />
              <p className="hint" style={{ gridColumn: "1 / -1", marginTop: 0 }}>
                These only ever TIGHTEN the profile. Setting one looser than the profile allows has no effect —
                a &ldquo;Conservative&rdquo; label that could be widened into Active limits would mean nothing.
              </p>
            </div>
          )}
        </div>

        <div className="row" style={{ marginTop: 14 }}>
          <button
            disabled={!valid || busy !== null || (!dirty && !advanced)}
            onClick={() => void onSave({ capital: amount, profile, ...(advanced ? { overrides } : {}) })}
          >
            {busy === "save" ? "Saving…" : "Save settings"}
          </button>
          {dirty && <span className="hint">Unsaved changes.</span>}
        </div>
      </div>

      <div className="panel">
        <span className="label">Step 4</span>
        <h2 style={{ marginTop: 8 }}>Turn on Autopilot</h2>
        <p style={{ maxWidth: "66ch" }}>
          Rivo will ask Privy for permission to sign for your Rivo Portfolio. You approve it once, in
          Privy&rsquo;s own prompt. After that Rivo can place, manage, exit and redeem Event Contract positions
          from that wallet while you are offline — and you will not be asked to approve individual trades,
          because that is the entire point.
        </p>
        <ul style={{ color: "var(--muted)", fontSize: 13.5, paddingLeft: 18, maxWidth: "66ch" }}>
          <li>
            <strong>Rivo never has your key.</strong> Privy holds it. Rivo holds a revocable right to ask for
            signatures, and nothing else.
          </li>
          <li>
            <strong>You can withdraw it at any time</strong> — switching Autopilot off here stops trading
            immediately and revokes the permission.
          </li>
          <li>
            <strong>The limits above are enforced by Rivo, in software.</strong> This venue offers no on-chain
            way to scope what a signer may do with Event Contracts, and we do not claim otherwise.
          </li>
        </ul>
        <div className="row" style={{ marginTop: 8 }}>
          <button className="primary" disabled={busy !== null || !valid} onClick={() => void onEnable()}>
            {busy === "autopilot" ? "Waiting for your approval…" : "Enable Autopilot"}
          </button>
          <span className="hint">You can stop it whenever you like.</span>
        </div>
        {view.autopilot.blocker && view.autopilot.state !== "idle" && (
          <div className="banner warn" style={{ marginTop: 12, marginBottom: 0 }}>
            {view.autopilot.blocker}
          </div>
        )}
      </div>
    </>
  );
}

function Limit({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat">
      <span className="label">{label}</span>
      <span className="value">{value.toFixed(2)}</span>
    </div>
  );
}

function Slider({
  label,
  value,
  onChange,
  capital,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  capital: number;
}) {
  return (
    <div className="field">
      <label className="label">{label}</label>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <div className="hint mono">
        {(value * 100).toFixed(0)}% · {(value * (Number.isFinite(capital) ? capital : 0)).toFixed(2)}
      </div>
    </div>
  );
}
