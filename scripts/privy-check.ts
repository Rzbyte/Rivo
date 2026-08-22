// `npm run privy:check` — is this deployment's Privy set up correctly?
//
// The answer to "did I configure Privy right" should be a command, not something
// an operator finds out when a user's first Autopilot attempt fails. This
// authenticates with the server's own credentials, reports what the app actually
// has enabled, and lists the manual dashboard steps Rivo cannot perform.
//
// It never signs anything and never touches a user's wallet.

import { loadEnv } from "../src/core/env.js";
import { preflight, POLICY_INTENT } from "../src/signing/privy.js";
import { VENUE } from "../src/core/venue.js";
import { network } from "../src/core/config.js";

const tick = (ok: boolean) => (ok ? "ok  " : "MISS");

async function main(): Promise<void> {
  loadEnv();
  const p = await preflight();
  const net = network();

  console.log("RIVO · Privy preflight");
  console.log("=".repeat(78));
  console.log(`  ${tick(Boolean(p.appId))}  PRIVY_APP_ID              ${p.appId ?? "(not set)"}`);
  console.log(`  ${tick(p.configured)}  PRIVY_APP_SECRET          ${p.configured ? "set" : "(not set)"}`);
  console.log(`  ${tick(p.authorizationKey)}  PRIVY_AUTHORIZATION_KEY   ${p.authorizationKey ? "set" : "(not set — optional, recommended)"}`);
  console.log(
    `  ${tick(Boolean(process.env.NEXT_PUBLIC_PRIVY_APP_ID))}  NEXT_PUBLIC_PRIVY_APP_ID  ${process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "(not set)"}`,
  );
  console.log("");

  if (p.reachable === null) {
    console.log("  Privy was not contacted — there are no credentials to try.");
  } else if (p.reachable) {
    console.log(`  ok    authenticated with Privy${p.appName ? ` as "${p.appName}"` : ""}`);
    console.log(`  ${tick(p.loginMethods.email)}  email login`);
    console.log(`  ${tick(p.loginMethods.google)}  google login`);
    console.log(`  ${tick(p.loginMethods.wallet)}  external wallet login`);
  } else {
    console.log("  MISS  Privy rejected these credentials.");
  }

  console.log("");
  console.log("MANUAL SETUP RIVO CANNOT DO FOR YOU  (dashboard.privy.io)");
  console.log("-".repeat(78));
  console.log("  1. Embedded wallets: create for ALL users, Ethereum.");
  console.log("     Rivo trades an embedded wallet whichever way the user signed in — including");
  console.log("     someone who connected an external wallet, who is exactly the person who most");
  console.log("     wants trading capital kept separate from it.");
  console.log(`  2. Add Somnia as a custom EVM chain: id ${VENUE.testnet.chainId} (testnet), ${VENUE.mainnet.chainId} (mainnet).`);
  console.log(`     RPC ${VENUE[net].rpc}`);
  console.log("  3. Enable delegated actions / server sessions, so a user can grant Rivo the");
  console.log("     right to sign while they are offline. This is what Autopilot asks for.");
  console.log("  4. Register an authorization keypair and set PRIVY_AUTHORIZATION_KEY.");
  console.log("");
  console.log("  Optional but recommended — a transaction policy on the portfolio wallets.");
  console.log("  Rivo declares the policy it WANTS; attaching it is your action, and until it is");
  console.log("  attached Rivo describes it as requested rather than enforced:");
  for (const a of POLICY_INTENT.allow) console.log(`    allow  ${a}`);
  for (const d of POLICY_INTENT.deny) console.log(`    deny   ${d}`);

  console.log("");
  if (p.problems.length === 0) {
    console.log("Nothing outstanding. Autopilot can be granted signing authority on this deployment.");
  } else {
    console.log(`${p.problems.length} thing(s) to fix:`);
    for (const problem of p.problems) console.log(`  · ${problem}`);
    // A missing authorization key is a recommendation, not a failure. Anything
    // else means a user cannot actually complete the flow.
    const blocking = p.problems.filter((x) => !x.startsWith("PRIVY_AUTHORIZATION_KEY"));
    if (blocking.length > 0) process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
