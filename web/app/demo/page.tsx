"use client";

// The dashboard, without a sign-in.
//
// Read-only, one portfolio, published only if the operator set
// RIVO_DEMO_PORTFOLIO_ID. It exists so that the interesting part of this product
// — that Rivo refuses trades, and says which constraint refused them — is
// visible to somebody who has thirty seconds and no account.

import { useCallback, useEffect, useState } from "react";
import { BrandMark } from "@/components/BrandMark";
import { Dashboard, type Bundle } from "@/components/Dashboard";
import { NETWORK } from "@/lib/somnia";

export default function DemoPage() {
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/demo", { cache: "no-store" });
      if (!res.ok) {
        setError("No demo portfolio is published on this deployment.");
        return;
      }
      setBundle((await res.json()) as Bundle);
      setError(null);
    } catch {
      setError("Could not reach Rivo.");
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <>
      <header className="top">
        <div className="wrap">
          <a className="brand" href="/">
            <BrandMark className="brand-mark" size={14} />
            Rivo
          </a>
          <div className="row">
            <span className="pill">{NETWORK}</span>
            <a className="btn primary" href="/app">
              Run your own
            </a>
          </div>
        </div>
      </header>
      <main className="wrap" style={{ paddingTop: 22, paddingBottom: 64 }}>
        <div className="banner">
          <strong>A live portfolio, read-only.</strong> This is one real portfolio managed by the same worker
          that would manage yours, against the live venue. Nothing here can be changed from this page — the
          controls are absent rather than disabled, because a button that does nothing is a worse lie than no
          button.
        </div>
        {error && <div className="banner warn">{error}</div>}
        {!bundle && !error && <p className="muted">Loading…</p>}
        {bundle && (
          <Dashboard
            bundle={bundle}
            balances={null}
            busy={null}
            readOnly
            onDisable={async () => {}}
            onSave={async () => {}}
          />
        )}
      </main>
    </>
  );
}
