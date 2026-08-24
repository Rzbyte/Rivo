"use client";

// Connecting an agent Rivo did not write.
//
// The form is small on purpose. Everything dangerous about this feature is on
// the server — the endpoint is vetted before it is stored and probed before it
// is trusted, because a URL a stranger supplies is a URL Rivo's own process will
// call. See src/intel/endpoint.ts.
//
// The token, if there is one, goes to the server and stays there. It is sent to
// the builder's own endpoint as a bearer header and is never returned by any
// read path: a secret that reaches the browser is a secret that is published.

import { useState } from "react";
import { usePrivy } from "@privy-io/react-auth";

interface Result {
  agent: { slug: string; label: string; state: string };
  probe: { action: string; reason: string | null };
}

export function ConnectAgent({ onConnected }: { onConnected?: () => void }) {
  const { ready, authenticated, login, getAccessToken } = usePrivy();
  const [label, setLabel] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [token, setToken] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Result | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const jwt = await getAccessToken();
      const res = await fetch("/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ label, endpoint, token: token || undefined, description: description || undefined }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Rivo could not connect that agent.");
      setDone(body as Result);
      setToken("");
      onConnected?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Rivo could not connect that agent.");
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="banner good">
        <strong>{done.agent.label} is connected.</strong> It starts as{" "}
        <span className="mono">{done.agent.state}</span> and runs in Live Shadow only — nothing reaches
        capital without passing the same validation Rivo&rsquo;s own model failed. Rivo asked it one
        question and it answered <span className="mono">{done.probe.action}</span>.
      </div>
    );
  }

  if (!ready) return <p className="muted">Loading…</p>;

  if (!authenticated) {
    return (
      <div className="row">
        <button className="primary" onClick={() => login()}>Sign in to connect an agent</button>
        <span className="hint">
          Browsing markets, calibration and evidence needs nothing. Owning a deployed agent needs an identity.
        </span>
      </div>
    );
  }

  const valid = label.trim().length >= 2 && /^https?:\/\/.+/i.test(endpoint.trim());

  return (
    <>
      {error && <div className="banner bad" style={{ marginBottom: 12 }}>{error}</div>}
      <div className="grid cols-2" style={{ gap: 12 }}>
        <div className="field">
          <label className="label" htmlFor="agent-label">Name</label>
          <input id="agent-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="My momentum agent" maxLength={60} />
        </div>
        <div className="field">
          <label className="label" htmlFor="agent-endpoint">Decision endpoint</label>
          <input id="agent-endpoint" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://your-agent.example/decide" />
          <p className="hint">
            Rivo POSTs one Event Contract at a time and expects the JSON below. Private and link-local
            addresses are refused.
          </p>
        </div>
        <div className="field">
          <label className="label" htmlFor="agent-token">Bearer token (optional)</label>
          <input id="agent-token" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="sent as Authorization: Bearer …" />
          <p className="hint">Stored server-side and never returned to a browser.</p>
        </div>
        <div className="field">
          <label className="label" htmlFor="agent-desc">Description (optional)</label>
          <input id="agent-desc" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} />
        </div>
      </div>
      <div className="row">
        <button className="primary" disabled={!valid || busy} onClick={() => void submit()}>
          {busy ? "Verifying endpoint…" : "Connect agent"}
        </button>
        <span className="hint">Rivo asks it one question before saving it.</span>
      </div>
    </>
  );
}
