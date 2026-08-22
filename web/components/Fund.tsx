"use client";

// Funding.
//
// The one step Rivo cannot do for the user, and should not pretend to. It shows
// the address, what is needed, and what has arrived — and it is honest about the
// two different failures, because they look the same from the outside and are
// not: no collateral means nothing to buy with, no gas means every transaction
// reverts before it starts, including the approval whose error message names
// nothing useful.

import { useState } from "react";
import type { Balances } from "@/lib/balances";
import { GAS_SYMBOL, NETWORK, explorerAddress } from "@/lib/somnia";

export function Fund({ address, balances }: { address: string; balances: Balances | null }) {
  const [copied, setCopied] = useState(false);
  const gas = balances?.gas;
  const collateral = balances?.collateral;
  const unknown = balances === null || (gas === null && collateral === null);

  return (
    <div className="panel">
      <span className="label">Step 2</span>
      <h2 style={{ marginTop: 8 }}>Fund your Rivo portfolio</h2>
      <p style={{ maxWidth: "64ch" }}>
        This address is your trading account. Rivo can place Event Contract orders from it once you enable
        Autopilot, and it can never move funds anywhere else. Send only what you are willing to put under
        management — everything Rivo does is bounded by this balance.
      </p>

      <div className="field">
        <span className="label">Your Rivo wallet</span>
        <div className="row">
          <code className="mono" style={{ fontSize: 13, wordBreak: "break-all", flex: "1 1 320px" }}>
            {address}
          </code>
          <button
            onClick={() => {
              void navigator.clipboard?.writeText(address).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1600);
              });
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
          <a className="btn" href={explorerAddress(address)} target="_blank" rel="noreferrer">
            Explorer
          </a>
        </div>
      </div>

      <div className="grid cols-2" style={{ marginTop: 6 }}>
        <Need
          label={balances?.collateralSymbol ?? "collateral"}
          have={collateral}
          need={10}
          why="What Rivo buys Event Contracts with."
        />
        <Need
          label={GAS_SYMBOL}
          have={gas}
          need={0.05}
          why="Gas. Without it every transaction reverts before it starts."
        />
      </div>

      {unknown && (
        <div className="banner warn" style={{ marginTop: 14, marginBottom: 0 }}>
          Could not read the balance just now. That is a failed check, not an empty wallet — nothing has been
          concluded from it.
        </div>
      )}

      {NETWORK === "testnet" && (
        <p className="hint" style={{ marginTop: 14 }}>
          On testnet both come from the Somnia faucet, which sends to any address you paste in.
        </p>
      )}
    </div>
  );
}

function Need({ label, have, need, why }: { label: string; have: number | null | undefined; need: number; why: string }) {
  const enough = typeof have === "number" && have >= need;
  return (
    <div className="stat">
      <span className="label">{label}</span>
      <span className={`value ${enough ? "pos" : ""}`}>
        {have === null || have === undefined ? "—" : have.toFixed(have < 1 ? 4 : 2)}
      </span>
      <span className="sub">
        {enough ? "enough to start" : `at least ${need} needed`} · {why}
      </span>
    </div>
  );
}
