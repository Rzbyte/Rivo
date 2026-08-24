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
import { useSendTransaction } from "@privy-io/react-auth";
import type { Balances } from "@/lib/balances";
import { COLLATERAL, GAS_SYMBOL, NETWORK, explorerAddress, explorerTx } from "@/lib/somnia";

/**
 * `faucet(uint256)` on the testnet collateral token.
 *
 * Test collateral is a SELF-MINT: the token's own faucet credits whoever sends
 * the transaction, so it has to come from this wallet and cannot be sent to it
 * by anybody else. That is why there is a button here rather than a link to a
 * website — and why a user with gas and no collateral was otherwise stuck at
 * this step with no way forward. Rivo cannot mint on their behalf either: it has
 * no authority over the wallet until Autopilot is enabled, which is the step
 * AFTER this one.
 *
 * Signed by the user in Privy's own prompt. No delegation involved.
 */
const FAUCET_SELECTOR = "0x57915897";
/** What one call mints, matching `npm run faucet` and the venue team's own command. */
const FAUCET_AMOUNT = 10_000_000_000n;

export function Fund({ address, balances }: { address: string; balances: Balances | null }) {
  const [copied, setCopied] = useState(false);
  const [minting, setMinting] = useState(false);
  const [mintError, setMintError] = useState<string | null>(null);
  const [mintTx, setMintTx] = useState<string | null>(null);
  const { sendTransaction } = useSendTransaction();
  const gas = balances?.gas;
  const collateral = balances?.collateral;
  const unknown = balances === null || (gas === null && collateral === null);
  // The mint costs gas like any other transaction. Offering the button without
  // it produces a revert whose message names nothing useful.
  const canMint = NETWORK === "testnet" && typeof gas === "number" && gas > 0.001;

  const mint = async () => {
    setMinting(true);
    setMintError(null);
    try {
      const { hash } = await sendTransaction({
        to: COLLATERAL.address,
        data: `${FAUCET_SELECTOR}${FAUCET_AMOUNT.toString(16).padStart(64, "0")}`,
        value: 0,
      });
      setMintTx(hash);
    } catch (e) {
      setMintError(
        e instanceof Error && /reject|denied|cancel/i.test(e.message)
          ? "You declined the transaction."
          : "The mint did not go through. Check that this wallet still has gas.",
      );
    } finally {
      setMinting(false);
    }
  };

  return (
    <div className="panel">
      <span className="label">Step 2</span>
      <h2 style={{ marginTop: 8 }}>Deployment wallet</h2>
      <p style={{ maxWidth: "64ch" }}>
        An agent that has passed validation needs somewhere to place Event Contract orders from. This is
        that account — testnet funds, held by Privy, kept apart from whatever wallet you normally use, and
        it can never move funds anywhere else. Nothing here is under management: it is the ceiling on what
        a deployed agent can spend while it is being proved.
      </p>

      <div className="field">
        <span className="label">Deployment wallet</span>
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

      {/* The dead end this closes: a wallet with no gas cannot mint test
          collateral either, because the mint is itself a transaction. The page
          said "you need gas" and stopped there, which leaves a new user — or a
          judge trying the product for the first time — with nowhere to go.

          There is no self-serve faucet URL to link to; Somnia's own docs route
          this through people. So the page names the routes that exist rather
          than inventing one that does not. */}
      {NETWORK === "testnet" && typeof gas === "number" && gas <= 0.001 && (
        <div className="banner warn" style={{ marginTop: 14, marginBottom: 0 }}>
          <strong>No {GAS_SYMBOL} yet, so nothing can move.</strong> Every transaction needs gas — including
          the button above that mints test collateral. Somnia hands out testnet {GAS_SYMBOL} through people
          rather than a self-serve tap: ask in{" "}
          <a href="https://discord.gg/somnia" target="_blank" rel="noreferrer">
            Somnia&rsquo;s Discord
          </a>{" "}
          <span className="mono">#dev-chat</span> with the address above, or email{" "}
          <span className="mono">developers@somnia.foundation</span> with what you are building. The{" "}
          <a href="https://testnet.somnia.network/" target="_blank" rel="noreferrer">
            testnet hub
          </a>{" "}
          has the network details if your wallet does not have Somnia yet.
        </div>
      )}

      {unknown && (
        <div className="banner warn" style={{ marginTop: 14, marginBottom: 0 }}>
          Could not read the balance just now. That is a failed check, not an empty wallet — nothing has been
          concluded from it.
        </div>
      )}

      {NETWORK === "testnet" && (
        <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--line)" }}>
          <span className="label">Testnet</span>
          <p className="hint" style={{ marginTop: 4 }}>
            <strong>{GAS_SYMBOL}</strong> comes from the Somnia faucet, which sends to any address you paste
            in. <strong>{COLLATERAL.symbol}</strong> does not — the token mints to whoever calls it, so the
            transaction has to come from this wallet. That is what this button does; you approve it in
            Privy&rsquo;s own prompt.
          </p>
          <div className="row" style={{ marginTop: 8 }}>
            <button className="primary" disabled={!canMint || minting} onClick={() => void mint()}>
              {minting ? "Waiting for your approval…" : `Mint test ${COLLATERAL.symbol}`}
            </button>
            {!canMint && <span className="hint">Needs {GAS_SYMBOL} for gas first.</span>}
          </div>
          {mintTx && (
            <p className="hint pos" style={{ marginTop: 8 }}>
              Sent —{" "}
              <a href={explorerTx(mintTx)} target="_blank" rel="noreferrer">
                {mintTx.slice(0, 12)}…
              </a>{" "}
              The balance above updates within a few seconds.
            </p>
          )}
          {mintError && (
            <p className="hint neg" style={{ marginTop: 8 }}>
              {mintError}
            </p>
          )}
        </div>
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
