"use client";

// The live portfolio.
//
// The layout is an argument. A trade blotter at the top would say what Rivo did;
// what this leads with is what Rivo is CARRYING and against which limits, then
// the decisions — refusals included — that produced it. A portfolio manager that
// only shows you its fills is indistinguishable from a bot, because the half
// that makes it a portfolio manager is the trades it declined.

import { useState } from "react";
import type { Balances } from "@/lib/balances";
import type { PortfolioView, DecisionGroup, ClosedPositionView } from "@rivo/db/view.js";
import type { ExecutionRecord } from "@rivo/ledger/types.js";
import type { RivoEvent } from "@rivo/db/events.js";
import { Decisions } from "./Decisions";
import { Executions } from "./Executions";
import { Exposure } from "./Exposure";
import { Positions } from "./Positions";
import { tenorLabel } from "@rivo/core/venue.js";

export interface Bundle {
  view: PortfolioView;
  decisions: DecisionGroup[];
  executions: ExecutionRecord[];
  closed: ClosedPositionView[];
  events: RivoEvent[];
}

type Tab = "decisions" | "positions" | "transactions" | "events";

export function Dashboard({
  bundle,
  balances,
  busy,
  readOnly = false,
  onDisable,
  onSave,
}: {
  bundle: Bundle;
  balances: Balances | null;
  busy: string | null;
  /**
   * Hide every control rather than disabling it.
   *
   * A disabled Stop button on a public page reads as "you could stop this if you
   * were signed in", which is not what it means — this portfolio is not yours.
   * Absent is the honest rendering.
   */
  readOnly?: boolean;
  onDisable: () => Promise<void>;
  onSave: (patch: { capital?: number; profile?: string }) => Promise<void>;
}) {
  const { view } = bundle;
  const [tab, setTab] = useState<Tab>("decisions");
  const money = (n: number) => n.toFixed(2);

  return (
    <>
      <StatusBanner view={view} />

      <div className="spread" style={{ marginBottom: 14 }}>
        <div className="row">
          <span className={`pill ${view.autopilot.live ? "live" : view.runtime.halted ? "stopped" : "shadow"}`}>
            <span className="dot" />
            {view.autopilot.live ? "Autopilot" : view.runtime.halted ? "Halted" : "Shadow Mode"}
          </span>
          <span className="pill">{view.profile}</span>
          <span className="faint" style={{ fontSize: 12.5 }}>
            {view.runtime.cycles.toLocaleString()} cycles ·{" "}
            {view.runtime.sinceLastCycleSec === null
              ? "no cycle yet"
              : `last ${formatAgo(view.runtime.sinceLastCycleSec)} ago`}
            {" · "}
            {/* The heartbeat, said plainly. A user who closed their browser an
                hour ago is entitled to see, in one glance, that something is
                still running on their behalf. */}
            <span className={view.worker.healthy ? "pos" : "neg"}>
              {view.worker.sinceHeartbeatSec === null
                ? "no worker has reported"
                : `worker alive ${formatAgo(view.worker.sinceHeartbeatSec)} ago`}
            </span>
          </span>
        </div>
        {!readOnly && (
          <button className="danger" disabled={busy !== null} onClick={() => void onDisable()}>
            {busy === "autopilot" ? "Stopping…" : "Stop Autopilot"}
          </button>
        )}
      </div>

      <section className="grid cols-4">
        <Stat label="Equity" value={money(view.equity)} sub={`${money(view.capital)} committed`} />
        <Stat
          label="Deployed"
          value={money(view.deployed)}
          sub={`${(view.utilisation * 100).toFixed(0)}% of the ${money(view.limits.deployedCap)} ceiling`}
          meter={view.utilisation}
        />
        <Stat label="Available" value={money(view.cash)} sub={`${money(view.limits.cashFloor)} never spent`} />
        <Stat
          label="Realised"
          value={(view.realizedPnl >= 0 ? "+" : "") + money(view.realizedPnl)}
          tone={view.realizedPnl >= 0 ? "pos" : "neg"}
          sub={`${view.counts.closedPositions} positions closed`}
        />
      </section>

      <div className="grid cols-2" style={{ marginTop: 14 }}>
        <Exposure view={view} />
        <div className="panel">
          <span className="label">Settling together</span>
          <h3 style={{ marginTop: 6 }}>Expiry concentration</h3>
          <p style={{ fontSize: 13, marginBottom: 10 }}>
            Positions that settle in the same fifteen minutes fail together, so they share a budget of{" "}
            {money(view.limits.expiryBucketCap)}.
          </p>
          {view.expiryBuckets.length === 0 ? (
            <p className="faint" style={{ marginBottom: 0, fontSize: 13 }}>
              Nothing open.
            </p>
          ) : (
            view.expiryBuckets.map((b) => (
              <div key={b.bucket} style={{ marginBottom: 8 }}>
                <div className="spread" style={{ fontSize: 12.5 }}>
                  <span className="mono">{b.bucket.replace("T", " ")}</span>
                  <span className="num">
                    {money(b.committed)} / {money(b.cap)}
                  </span>
                </div>
                <Meter used={b.cap > 0 ? b.committed / b.cap : 0} />
              </div>
            ))
          )}
        </div>
      </div>

      <Reconciliation view={view} />

      <nav className="row" style={{ marginTop: 22, marginBottom: 12, gap: 4 }}>
        {(
          [
            ["decisions", `Decisions`],
            ["positions", `Positions (${view.counts.openPositions})`],
            ["transactions", `Transactions (${view.counts.executions})`],
            ["events", `Events (${bundle.events.length})`],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            aria-pressed={tab === id}
            className={tab === id ? "primary" : ""}
            style={{ fontSize: 13, padding: "6px 12px" }}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === "decisions" && <Decisions groups={bundle.decisions} />}
      {tab === "positions" && <Positions view={view} closed={bundle.closed} />}
      {tab === "transactions" && <Executions rows={bundle.executions} />}
      {tab === "events" && <Events rows={bundle.events} />}

      {!readOnly && (
      <details className="panel" style={{ marginTop: 18 }}>
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>Settings</summary>
        <div className="grid cols-2" style={{ marginTop: 12 }}>
          <div>
            <span className="label">Capital</span>
            <p className="hint">
              Changing this rescales every limit. Reducing it below what is already deployed does not force a
              sale — Rivo stops adding and lets the existing positions settle.
            </p>
            <CapitalEditor current={view.capital} busy={busy} onSave={onSave} />
          </div>
          <div>
            <span className="label">Rivo Portfolio</span>
            <p className="mono" style={{ fontSize: 12.5, wordBreak: "break-all" }}>
              {view.address}
            </p>
            <p className="hint">
              {balances
                ? `${balances.collateral?.toFixed(2) ?? "—"} ${balances.collateralSymbol} · ${balances.gas?.toFixed(4) ?? "—"} ${balances.gasSymbol} on chain`
                : "balance unknown"}
            </p>
            {view.runtime.tradedBy && view.runtime.tradedBy.toLowerCase() !== view.address.toLowerCase() && (
              <p className="hint warn">
                This portfolio&rsquo;s history was produced by {view.runtime.tradedBy}, which is not the wallet
                configured now.
              </p>
            )}
          </div>
        </div>
      </details>
      )}
    </>
  );
}

function StatusBanner({ view }: { view: PortfolioView }) {
  if (view.runtime.halted) {
    return (
      <div className="banner bad">
        <strong>Trading halted.</strong> {view.runtime.halted} Rivo will not restart on its own — that is
        deliberate, because a breaker that resets itself is not a breaker.
      </div>
    );
  }
  if (!view.worker.healthy) {
    return (
      <div className="banner warn">
        <strong>No worker is running.</strong> Your settings are saved and your positions are safe, but nothing
        is executing cycles right now. Positions will be managed as soon as a worker comes back.
      </div>
    );
  }
  if (view.runtime.dryRun && view.autopilot.mode === "autopilot") {
    return (
      <div className="banner warn">
        <strong>Shadow Mode.</strong> {view.autopilot.blocker ?? "Rivo is deciding but not sending orders."}
      </div>
    );
  }
  if (view.autopilot.blocker) return <div className="banner warn">{view.autopilot.blocker}</div>;
  return null;
}

function Stat({
  label,
  value,
  sub,
  tone,
  meter,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "pos" | "neg";
  meter?: number;
}) {
  return (
    <div className="panel stat">
      <span className="label">{label}</span>
      <span className={`value ${tone ?? ""}`}>{value}</span>
      {meter !== undefined && <Meter used={meter} />}
      {sub && <span className="sub">{sub}</span>}
    </div>
  );
}

export function Meter({ used }: { used: number }) {
  const pct = Math.max(0, Math.min(1, used)) * 100;
  return (
    <div className="meter">
      <span className={used > 1 ? "over" : used > 0.8 ? "hot" : ""} style={{ width: `${pct}%` }} />
    </div>
  );
}

/**
 * What the chain and Rivo disagreed about, and what is still in flight.
 *
 * Hidden entirely when there is nothing to say, which is the normal state — a
 * permanently-visible "0 mismatches" panel trains people to stop reading it, and
 * this is precisely the panel that must be read on the day it says something.
 */
function Reconciliation({ view }: { view: PortfolioView }) {
  const r = view.reconciliation;
  const quiet =
    r.adopted === 0 && r.pendingExecutions === 0 && r.failedExecutions === 0 && r.orphanedExecutions === 0;
  if (quiet) return null;
  return (
    <div className="panel" style={{ marginTop: 14 }}>
      <span className="label">Chain vs. Rivo</span>
      <h3 style={{ marginTop: 6 }}>Reconciliation</h3>
      <div className="grid cols-4" style={{ marginTop: 10 }}>
        {r.adopted > 0 && (
          <Note
            label="Adopted positions"
            value={r.adopted}
            tone="warn"
            note="Found on-chain, not opened by Rivo. Their entry price is an estimate — nothing on-chain records what was paid."
          />
        )}
        {r.pendingExecutions > 0 && (
          <Note label="In flight" value={r.pendingExecutions} note="Sent, or about to be. Resolved against the chain on the next cycle." />
        )}
        {r.failedExecutions > 0 && (
          <Note label="Failed" value={r.failedExecutions} tone="neg" note="Rejected or reverted, each with its reason on the Transactions tab." />
        )}
        {r.orphanedExecutions > 0 && (
          <Note
            label="Outcome unknown"
            value={r.orphanedExecutions}
            tone="warn"
            note="Sent, and no receipt could be found. NOT the same as failed — what the wallet holds comes from the chain instead."
          />
        )}
      </div>
      {r.lastAt !== null && (
        <p className="hint" style={{ marginTop: 8, marginBottom: 0 }}>
          {r.events} reconciliation finding{r.events === 1 ? "" : "s"} recorded · last{" "}
          {new Date(r.lastAt * 1000).toISOString().slice(5, 16).replace("T", " ")}
        </p>
      )}
    </div>
  );
}

function Note({ label, value, note, tone }: { label: string; value: number; note: string; tone?: "warn" | "neg" }) {
  return (
    <div className="stat">
      <span className="label">{label}</span>
      <span className={`value ${tone ?? ""}`}>{value}</span>
      <span className="sub">{note}</span>
    </div>
  );
}

function Events({ rows }: { rows: RivoEvent[] }) {
  if (rows.length === 0) {
    return (
      <div className="panel">
        <p className="faint" style={{ marginBottom: 0 }}>
          Nothing has needed your attention. Refused trades are not events — they are decisions, and they are
          on the previous tab.
        </p>
      </div>
    );
  }
  return (
    <div className="panel scroll">
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>What</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.id}>
              <td className="mono faint" style={{ whiteSpace: "nowrap" }}>
                {new Date(e.at * 1000).toISOString().slice(5, 16).replace("T", " ")}
              </td>
              <td className={e.severity === "error" ? "neg" : e.severity === "warn" ? "warn" : "muted"}>
                {e.kind}
              </td>
              <td>{e.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CapitalEditor({
  current,
  busy,
  onSave,
}: {
  current: number;
  busy: string | null;
  onSave: (patch: { capital?: number }) => Promise<void>;
}) {
  const [value, setValue] = useState(String(current));
  const n = Number(value);
  return (
    <div className="row">
      <input className="mono" style={{ maxWidth: 140 }} value={value} onChange={(e) => setValue(e.target.value)} />
      <button
        disabled={busy !== null || !Number.isFinite(n) || n <= 0 || n === current}
        onClick={() => void onSave({ capital: n })}
      >
        {busy === "save" ? "Saving…" : "Update"}
      </button>
    </div>
  );
}

export const tenor = (sec: number): string => tenorLabel(sec);

function formatAgo(sec: number): string {
  if (sec < 90) return `${sec}s`;
  if (sec < 5400) return `${Math.round(sec / 60)}m`;
  return `${Math.round(sec / 3600)}h`;
}
