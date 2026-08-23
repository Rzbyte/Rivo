"use client";

// The product.
//
// One page with two faces: an onboarding sequence until the portfolio is
// configured and Autopilot is on, and a dashboard afterwards. They are the same
// component because they are the same object at different stages, and splitting
// them would mean two places that decide what "ready" means.
//
// THE SEQUENCE, and why it is in this order:
//
//   1. sign in            Privy. Email, Google, or an existing wallet.
//   2. Rivo Portfolio     The trading account Privy creates, registered with Rivo.
//                         Automatic — the user is never asked to make a wallet.
//   3. fund it            The user's own money moves once, to an address they
//                         control. Rivo cannot do this for them and does not try.
//   4. configure          Capital and risk. Defaults that are already sane.
//   5. Autopilot          The consent step. This is where authority is granted,
//                         in Privy's own prompt, and it is the only step that
//                         changes what Rivo is allowed to do.
//
// Step 3 is deliberately before step 5. Granting signing authority over an empty
// wallet is harmless and granting it over a funded one is not, so the user sees
// the balance they are putting under management before they are asked.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
// `useDelegatedActions`, NOT the headless variant.
//
// Both expose the same two functions and they differ in exactly the thing this
// screen promises: the headless one delegates without any UI, while this one
// "prompts the user to delegate access". Rivo's copy says the user approves it
// once in Privy's own prompt, and with the headless hook no prompt ever
// appeared — the button simply sat on "Waiting for your approval…" forever,
// waiting for something that was never going to be shown.
import { usePrivy, useDelegatedActions, useLogout } from "@privy-io/react-auth";
import type { WalletWithMetadata } from "@privy-io/react-auth";
import { api, ApiError } from "@/lib/api";
import { readBalances, type Balances } from "@/lib/balances";
import { NETWORK, explorerAddress } from "@/lib/somnia";
import type { PortfolioView } from "@rivo/db/view.js";
import { Dashboard, type Bundle } from "@/components/Dashboard";
import { Configure } from "@/components/Configure";
import { Fund } from "@/components/Fund";
import { Steps } from "@/components/Steps";

const APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "";

// `Bundle` is the dashboard's payload and is defined once, next to the component
// that renders it. Declaring it a second time here — loosely, as unknown[] —
// was enough to make the compiler see two unrelated types with the same name.

export default function AppPage() {
  if (!APP_ID) return <Shell><p>This deployment is not configured for sign-in.</p></Shell>;
  return <Portfolio />;
}

function Portfolio() {
  const { ready, authenticated, getAccessToken, user } = usePrivy();
  const { delegateWallet, revokeWallets } = useDelegatedActions();
  const { logout } = useLogout();
  const router = useRouter();

  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [balances, setBalances] = useState<Balances | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [booted, setBooted] = useState(false);

  const token = useCallback(async () => getAccessToken(), [getAccessToken]);

  /**
   * The Privy embedded wallet, from the user's linked accounts.
   *
   * `useWallets()` reports what is CONNECTED, which for an external login
   * includes the user's own wallet — and picking the wrong one here would point
   * the whole product at the wallet Rivo must never touch. The linked-account
   * record is the authoritative one, and it carries the two fields that matter:
   * `delegated`, and the `id` Privy issues only once delegation exists.
   */
  const embedded = useMemo<WalletWithMetadata | null>(() => {
    const accounts = (user?.linkedAccounts ?? []) as WalletWithMetadata[];
    return (
      accounts.find(
        (a) => a.type === "wallet" && a.chainType === "ethereum" && String(a.walletClientType ?? "").startsWith("privy"),
      ) ?? null
    );
  }, [user]);

  const address = embedded?.address ?? null;

  useEffect(() => {
    if (ready && !authenticated) router.replace("/");
  }, [ready, authenticated, router]);

  /** Register the wallet, make sure a portfolio exists, and load it. */
  const refresh = useCallback(
    async (opts: { create?: boolean } = {}) => {
      if (!address) return;
      try {
        setError(null);
        await api(token, "/api/me", {
          method: "POST",
          body: {
            address,
            kind: "portfolio",
            // Present only after delegation. Sent whenever we have it so the
            // worker is never the thing that discovers it is missing.
            ...(embedded?.id ? { privyWalletId: embedded.id } : {}),
          },
        });
        let list = await api<{ portfolios: { id: string }[] }>(token, "/api/portfolios");
        if (list.portfolios.length === 0 && opts.create) {
          await api(token, "/api/portfolios", { method: "POST", body: { capital: 50, profile: "balanced" } });
          list = await api<{ portfolios: { id: string }[] }>(token, "/api/portfolios");
        }
        const first = list.portfolios[0];
        if (!first) {
          setBundle(null);
          return;
        }
        setBundle(await api<Bundle>(token, `/api/portfolios/${first.id}`));
      } catch (e) {
        setError(e instanceof ApiError ? e.message : "could not reach Rivo");
      } finally {
        setBooted(true);
      }
    },
    [address, embedded?.id, token],
  );

  // Boot: register the wallet and create the portfolio if this is a first visit.
  useEffect(() => {
    if (!ready || !authenticated || !address) return;
    void refresh({ create: true });
  }, [ready, authenticated, address, refresh]);

  // Balances, and then on a slow poll. The user is watching a number they just
  // sent money to; five seconds of staleness is the difference between "it
  // worked" and "did it work".
  useEffect(() => {
    if (!address) return;
    let live = true;
    const tick = () => void readBalances(address).then((b) => live && setBalances(b));
    tick();
    const t = setInterval(tick, 12_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [address]);

  // The portfolio, while Autopilot is on. A cycle is 45 seconds; polling at 15
  // means a decision is visible within a third of a cycle of being made.
  useEffect(() => {
    if (!bundle?.view.autopilot.live) return;
    const t = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(t);
  }, [bundle?.view.autopilot.live, refresh]);

  const enableAutopilot = useCallback(async () => {
    if (!bundle || !address) return;
    setBusy("autopilot");
    setError(null);
    try {
      // The consent step. Privy shows its own prompt; Rivo is not in the middle
      // of it and does not see anything but the outcome.
      //
      // Bounded, because an unsettled promise here is indistinguishable from a
      // user who has not clicked yet — and that is exactly how this button spent
      // its first outing stuck on "Waiting for your approval…" with nothing
      // wrong that anybody could see. Ninety seconds is far longer than reading
      // a prompt takes and short enough to be a failure rather than a mood.
      if (!embedded?.delegated) {
        await withTimeout(
          delegateWallet({ address, chainType: "ethereum" }),
          90_000,
          "Privy never showed the permission prompt. Either this app has wallet UIs suppressed in its " +
            "Privy client config, or delegated actions (signers) are not enabled on the Privy app.",
        );
      }
      // Re-read the linked account: the wallet id exists only after delegation,
      // and the worker needs it.
      const refreshed = ((user?.linkedAccounts ?? []) as WalletWithMetadata[]).find(
        (a) => a.type === "wallet" && a.address === address,
      );
      await api(token, `/api/portfolios/${bundle.view.id}/autopilot`, {
        method: "POST",
        body: { enabled: true, delegated: true, privyWalletId: refreshed?.id ?? embedded?.id ?? undefined },
      });
      await refresh();
    } catch (e) {
      // Show what actually went wrong. "Did not complete" is true of a declined
      // prompt, a disabled dashboard setting and a network failure alike, and
      // tells the user nothing about which one they are in.
      setError(
        e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Autopilot was not enabled.",
      );
    } finally {
      setBusy(null);
    }
  }, [bundle, address, embedded, delegateWallet, token, refresh, user]);

  const disableAutopilot = useCallback(async () => {
    if (!bundle) return;
    setBusy("autopilot");
    try {
      // Rivo's own switch FIRST, and it is the one that actually stops trading.
      // The portfolio is set to stopped and the wallet marked undelegated
      // server-side, so the worker will not touch it from the next scheduler
      // pass onwards — whatever happens next.
      await api(token, `/api/portfolios/${bundle.view.id}/autopilot`, { method: "POST", body: { enabled: false } });

      // Then withdraw the grant at Privy itself.
      //
      // This used to be missing, and the omission was the kind that reads fine:
      // the UI said "revokes the permission", Rivo stopped trading, and the
      // grant quietly stood. Stopping is not revoking. A user who turns
      // Autopilot off is entitled to have Rivo lose the ability to ask, not
      // merely the intention to.
      //
      // Failure here is reported and does not undo the stop above — a portfolio
      // that is stopped with a standing grant does nothing, which is the safe
      // half of the two.
      try {
        await withTimeout(revokeWallets(), 60_000, "Privy did not confirm the revocation.");
      } catch {
        setError(
          "Autopilot is off and Rivo will not trade this portfolio. Withdrawing the signing permission at Privy " +
            "did not complete — you can remove it from your Privy account settings.",
        );
      }
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "could not switch Autopilot off");
    } finally {
      setBusy(null);
    }
  }, [bundle, token, refresh, revokeWallets]);

  const save = useCallback(
    async (patch: { capital?: number; profile?: string; overrides?: Record<string, unknown> }) => {
      if (!bundle) return;
      setBusy("save");
      try {
        await api(token, `/api/portfolios/${bundle.view.id}`, { method: "PATCH", body: patch });
        await refresh();
      } catch (e) {
        setError(e instanceof ApiError ? e.message : "could not save");
      } finally {
        setBusy(null);
      }
    },
    [bundle, token, refresh],
  );

  if (!ready || !booted) return <Shell><p className="muted">Loading your portfolio…</p></Shell>;
  if (!authenticated) return <Shell><p className="muted">Redirecting…</p></Shell>;

  const view = bundle?.view ?? null;
  const funded = (balances?.collateral ?? 0) > 0;
  // "Has a capital figure" is not "the user chose one". A portfolio is created
  // with a sensible default, so capital is non-zero from the first instant —
  // and ticking this step before the user has touched anything makes the whole
  // indicator untrustworthy. A saved change moves `updatedAt` past `createdAt`.
  const configured = view !== null && view.updatedAt > view.createdAt;
  const on = view?.autopilot.live === true;

  return (
    <Shell
      right={
        <div className="row">
          {address && (
            <a className="pill mono" href={explorerAddress(address)} target="_blank" rel="noreferrer" title={address}>
              {address.slice(0, 6)}…{address.slice(-4)}
            </a>
          )}
          <button className="link" onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      }
    >
      {error && <div className="banner bad">{error}</div>}

      {!on && (
        <Steps
          steps={[
            { label: "Rivo Portfolio", done: Boolean(address) },
            { label: "Funded", done: funded },
            { label: "Configured", done: configured },
            { label: "Autopilot", done: on },
          ]}
        />
      )}

      {!address && (
        <div className="panel">
          <h2>Opening your Rivo Portfolio…</h2>
          <p style={{ marginBottom: 0 }}>
            This is the trading account Rivo manages. It is yours, held by Privy, and deliberately separate
            from any wallet you already use — so what Rivo can act on is only ever what you put in it.
          </p>
        </div>
      )}

      {address && !funded && <Fund address={address} balances={balances} />}

      {address && funded && view && !on && (
        <Configure
          view={view}
          balances={balances}
          busy={busy}
          onSave={save}
          onEnable={enableAutopilot}
        />
      )}

      {address && view && on && (
        <Dashboard
          bundle={bundle!}
          balances={balances}
          busy={busy}
          onDisable={disableAutopilot}
          onSave={save}
        />
      )}
    </Shell>
  );
}

/**
 * Fail a promise that never settles.
 *
 * A hung await and a user who has not clicked yet look identical from here, and
 * the difference matters: one is a state to wait in and the other is a dead end
 * with a spinner on it.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

function Shell({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <>
      <header className="top">
        <div className="wrap">
          <a className="brand" href="/">
            Rivo
          </a>
          <div className="row">
            <span className="pill">{NETWORK}</span>
            {right}
          </div>
        </div>
      </header>
      <main className="wrap" style={{ paddingTop: 26, paddingBottom: 64 }}>
        {children}
      </main>
    </>
  );
}
