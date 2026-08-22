"use client";

// The permanent transaction record.
//
// Every row here outlives the position it belonged to. That is the whole reason
// the table exists: provenance used to live on the position object, so closing a
// position deleted the record of the transaction that opened it, and a finished
// portfolio could show two hundred positions and ten hashes.
//
// The statuses are shown as they are, including the uncomfortable one. `orphaned`
// means a transaction was sent and no receipt could be found — not that it
// failed. Rendering it as a failure would be a guess in the one direction that
// makes a duplicate trade look reasonable.

import type { ExecutionRecord } from "@rivo/ledger/types.js";
import { explorerTx } from "@/lib/somnia";

const TONE: Record<string, string> = {
  confirmed: "pos",
  failed: "neg",
  orphaned: "warn",
  submitted: "muted",
  intended: "faint",
};

const EXPLAIN: Record<string, string> = {
  intended: "Recorded before signing. Nothing was sent.",
  submitted: "Sent to the chain; waiting for a receipt.",
  confirmed: "Confirmed on-chain.",
  failed: "Rejected or reverted, with the reason.",
  orphaned: "Sent, and no receipt could be found. NOT the same as failed — the outcome is unknown, and position truth comes from on-chain reconciliation.",
};

export function Executions({ rows }: { rows: ExecutionRecord[] }) {
  if (rows.length === 0) {
    return (
      <div className="panel">
        <p className="faint" style={{ marginBottom: 0 }}>
          No transactions yet. In Shadow Mode, simulated actions are recorded here too and marked as such.
        </p>
      </div>
    );
  }
  return (
    <div className="panel">
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Action</th>
              <th>Market</th>
              <th className="n">Requested</th>
              <th className="n">Filled</th>
              <th className="n">Price</th>
              <th>Status</th>
              <th>Transaction</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="mono faint" style={{ whiteSpace: "nowrap" }}>
                  {new Date(r.createdAt * 1000).toISOString().slice(5, 16).replace("T", " ")}
                </td>
                <td>
                  <strong>{r.action}</strong>
                  {r.leg && <span className="faint"> {r.leg}</span>}
                  {r.mode === "dry" && (
                    <span className="pill" style={{ marginLeft: 6, fontSize: 10 }}>
                      shadow
                    </span>
                  )}
                </td>
                <td className="mono faint">{r.marketId.slice(0, 10)}…</td>
                <td className="n">{r.requestedQty?.toFixed(2) ?? "—"}</td>
                <td className="n">{r.filledQty?.toFixed(2) ?? "—"}</td>
                <td className="n">{r.filledPrice !== undefined ? r.filledPrice.toFixed(3) : r.requestedPrice?.toFixed(3) ?? "—"}</td>
                <td className={TONE[r.status] ?? ""} title={EXPLAIN[r.status]}>
                  {r.status}
                  {r.error && (
                    <div className="hint" style={{ maxWidth: 260 }}>
                      {r.error}
                    </div>
                  )}
                </td>
                <td className="mono">
                  {r.txHash ? (
                    <a href={explorerTx(r.txHash)} target="_blank" rel="noreferrer">
                      {r.txHash.slice(0, 10)}…
                    </a>
                  ) : (
                    <span className="faint">—</span>
                  )}
                  {r.blockNumber !== undefined && <div className="hint">block {r.blockNumber.toLocaleString()}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="hint" style={{ marginTop: 12, marginBottom: 0 }}>
        This record is append-only and enforced by the database: a row cannot be deleted, its intent cannot be
        rewritten, and a recorded transaction hash cannot be replaced with a different one.
      </p>
    </div>
  );
}
