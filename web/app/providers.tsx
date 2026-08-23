"use client";

// Identity and wallets.
//
// Three login methods, one wallet. Email and Google are the point — a person who
// has never held a private key should be able to use this — and "connect wallet"
// is there for people who already have one and would rather sign in with it.
//
// The wallet Rivo trades is ALWAYS the Privy embedded wallet, whichever way the
// user signed in, and that is a product decision rather than a technical one:
//
//   * It isolates trading capital. Rivo's authority reaches the portfolio wallet
//     and nothing else, so the worst case is bounded by what the user funded it
//     with rather than by everything their main wallet has ever held.
//   * It can sign while the user is asleep. A connected browser wallet cannot —
//     a closed tab signs nothing — and any product implying otherwise is either
//     round-tripping a key to a server or not doing what it says.
//
// So an external wallet is identity and a funding source. It is never asked to
// sign a trade, and there is no code path here that could ask it to.

import { PrivyProvider } from "@privy-io/react-auth";
import { CHAIN, SOMNIA_MAINNET, SOMNIA_TESTNET } from "@/lib/somnia";

const APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "";

export function Providers({ children }: { children: React.ReactNode }) {
  // A missing app id is a configuration mistake, and it should look like one
  // rather than like a broken login button. Rendering the children unwrapped
  // lets the page say so itself — see `MissingPrivy` on the landing page.
  if (!APP_ID) return <>{children}</>;

  return (
    <PrivyProvider
      appId={APP_ID}
      config={{
        // `loginMethods` is deliberately ABSENT.
        //
        // Privy's own docs are explicit that this parameter "enables you to
        // display a SUBSET of the login methods specified in the developer
        // dashboard", and that anything listed here "must also be enabled as a
        // login method in the developer dashboard". So hard-coding it can only
        // ever narrow what an operator has turned on — never widen it.
        //
        // It was hard-coded to email/google/wallet, and that was worse than
        // pointless: the dashboard had Google switched off, so the code offered
        // a method the app could not serve, and enabling Apple or Discord or a
        // passkey later would have required a code change and a redeploy to
        // become visible.
        //
        // Omitting it makes the dashboard the single source of truth. Turn a
        // method on at dashboard.privy.io and it appears here on the next page
        // load. `npm run privy:check` reports which are live.
        appearance: {
          theme: "dark",
          accentColor: "#a8cf9a",
          logo: undefined,
          walletChainType: "ethereum-only",
        },
        // Every user gets a Rivo wallet, including one who signed in with an
        // external wallet — `users-without-wallets` would skip exactly that
        // person, and they are the one who most needs their trading capital kept
        // separate from their main wallet.
        embeddedWallets: {
          ethereum: { createOnLogin: "all-users" },
          showWalletUIs: false,
        },
        supportedChains: [SOMNIA_TESTNET, SOMNIA_MAINNET],
        defaultChain: CHAIN,
      }}
    >
      {children}
    </PrivyProvider>
  );
}
