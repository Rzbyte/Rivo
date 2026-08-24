"use client";

// Paste a URL, watch it get judged. No account.
//
// Everything else on this page describes what Rivo does to an agent. This is
// the only part that does it — and it was behind a sign-in, so the capability
// most worth trying was the one nobody could try. A reader who runs one trial
// has learned more about the product than the rest of the page can tell them.
//
// Nothing here is stored. The trial runs in shadow, so no signer is reachable
// from the path in any case, and the response says so on every result.

import { useState } from "react";

interface Trial {
  asked: {
    market: { asset: string; leg: string; intervalSec: number; secondsLeft: number };
    price: { bid: number | null; ask: number | null; depth: number };
    reference: { spot: number | null; probability: number | null };
    limits: { maxNotional: number };
  };
  answered: {
    action: string; probability: number | null; confidence: number | null;
    notional: number; reason: string | null;
  };
  verdict: {
    outcome: string; stage: string; code: string | null; reason: string;
    normalizedSize: number; cost: number;
  };
  execution: string;
  limits: { maxNotional: number; triesPerMinute: number };
}

const pct = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(1)}%`);

export function TryAgent() {
  const [endpoint, setEndpoint] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trial, setTrial] = useState<Trial | null>(null);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    if (!endpoint.trim() || busy) return;
    setBusy(true);
    setError(null);
    setTrial(null);
    try {
      const res = await fetch("/api/try-agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoint: endpoint.trim() }),
      });
      const body = (await res.json()) as Trial & { error?: string };
      if (!res.ok) {
        // The endpoint's refusals are written for a builder, so they are worth
        // showing exactly rather than replacing with "something went wrong".
        setError(body.error ?? `Rivo could not run that trial (${res.status}).`);
        return;
      }
      setTrial(body);
    } catch {
      setError("Could not reach Rivo. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  const v = trial?.verdict;
  const tone = v?.outcome === "EXECUTE" ? "good" : v?.outcome === "REFUSED" ? "caution" : "";

  return (
    <div className="panel">
      <form onSubmit={run}>
        <div className="field">
          <label className="label" htmlFor="try-endpoint">Your decision endpoint</label>
          <input
            id="try-endpoint"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="https://your-agent.example/decide"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
          />
          <p className="hint">
            Rivo picks the deepest live DreamDEX window, POSTs it to you, and runs your answer through
            the same pre-execution pipeline real execution uses. Nothing is stored and no account is
            needed.
          </p>
        </div>
        <div className="row" style={{ marginTop: 10, gap: 10 }}>
          <button className="primary" type="submit" disabled={busy || !endpoint.trim()}>
            {busy ? "Asking your agent…" : "Run one trial"}
          </button>
          <span className="hint">No transaction can be sent from here.</span>
        </div>
      </form>

      {error && <div className="banner bad" style={{ marginTop: 14, marginBottom: 0 }}>{error}</div>}

      {trial && v && (
        <div style={{ marginTop: 18 }}>
          <div className="sec-head" style={{ marginTop: 0 }}>
            <h2 style={{ fontSize: 17 }}>
              {trial.asked.market.asset} {trial.asked.market.leg} ·{" "}
              {Math.round(trial.asked.market.intervalSec / 60)}m
            </h2>
            <span className={`verdict ${tone}`}>
              {v.outcome === "EXECUTE" ? "WOULD ENTER" : v.outcome}
            </span>
          </div>

          <div className="kv">
            <div><span className="k">venue ask</span><span className="v">{pct(trial.asked.price.ask)}</span></div>
            <div><span className="k">book depth</span><span className="v">{trial.asked.price.depth.toFixed(1)} sh</span></div>
            <div><span className="k">rivo reference</span><span className="v">{pct(trial.asked.reference.probability)}</span></div>
            <div><span className="k">expires in</span><span className="v">{trial.asked.market.secondsLeft}s</span></div>
          </div>

          <div className="grid cols-2" style={{ marginTop: 14, gap: 12 }}>
            <div className="panel" style={{ margin: 0 }}>
              <span className="label">Your agent said</span>
              <div className="kv" style={{ marginTop: 8 }}>
                <div><span className="k">action</span><span className="v">{trial.answered.action}</span></div>
                <div><span className="k">probability</span><span className="v">{pct(trial.answered.probability)}</span></div>
                <div><span className="k">asked for</span><span className="v">{trial.answered.notional.toFixed(2)}</span></div>
              </div>
              {trial.answered.reason && (
                <p className="hint" style={{ marginTop: 8, marginBottom: 0 }}>{trial.answered.reason}</p>
              )}
            </div>

            <div className="panel" style={{ margin: 0 }}>
              <span className="label">Rivo would have</span>
              <div className="kv" style={{ marginTop: 8 }}>
                <div><span className="k">outcome</span><span className="v">{v.outcome}</span></div>
                <div><span className="k">stopped at</span><span className="v">{v.stage}</span></div>
                <div><span className="k">venue size</span><span className="v">{v.normalizedSize.toFixed(2)} sh</span></div>
              </div>
              <p className="hint" style={{ marginTop: 8, marginBottom: 0 }}>
                {v.code ? `${v.code} — ` : ""}
                {v.reason}
              </p>
            </div>
          </div>

          <p className="hint" style={{ marginTop: 12, marginBottom: 0 }}>
            <strong>{trial.execution}</strong> To run continuously against every live window and have
            the results resolve against real settlements, connect the agent below.
          </p>
        </div>
      )}
    </div>
  );
}
