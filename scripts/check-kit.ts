// `npm run check:kit` — does the installed bot kit still export what we call?
//
// Rivo declares `ec-core`'s surface locally so the repo installs standalone
// (see src/runtime/ec-core-types.ts). The cost of that choice is that the
// compiler cannot catch drift between our contract and the kit's real exports.
// This closes the gap: run it whenever the kit is updated, and before trusting
// the live path.

import { EC_CORE_EXPORTS, DEFAULT_EC_CORE_SPECIFIER } from "../src/runtime/ec-core-types.js";

async function main(): Promise<void> {
  const specifier = process.env.RIVO_EC_CORE ?? DEFAULT_EC_CORE_SPECIFIER;
  console.log(`checking "${specifier}" against the surface Rivo calls`);

  let mod: Record<string, unknown>;
  try {
    mod = (await import(specifier)) as Record<string, unknown>;
  } catch (e) {
    console.error(`\nNOT INSTALLED — ${e instanceof Error ? e.message : String(e)}`);
    console.error(`\nThis is expected unless you intend to trade live. Read-only commands`);
    console.error(`(calibrate, scan, allocate, backtest, report, dry-run runtime) do not need it.`);
    console.error(`\nTo install: clone the kit beside this repo, \`npm install\` inside it, then \`npm run link:kit\`.`);
    process.exitCode = 1;
    return;
  }

  let missing = 0;
  for (const name of EC_CORE_EXPORTS) {
    const ok = typeof mod[name] === "function";
    console.log(`  ${ok ? "ok  " : "MISS"}  ${name}`);
    if (!ok) missing++;
  }

  // The signer-binding path, checked by USING it rather than by grepping.
  //
  // Per-user autonomous signing rests on one fact about somebody else's package:
  // an exchange built without a signer can be given one afterwards, and the SDK
  // accepts any viem account as its local-signing path. That is documented on
  // `bindSigner` in src/runtime/ec-core-types.ts, and a documented fact about a
  // dependency is a fact that will be wrong one day. This is where we find out —
  // in a check that takes a second, rather than in a live cycle that cannot sign.
  console.log("");
  console.log("checking the signer-binding path Rivo uses for per-user wallets");
  try {
    const ctx = (mod.createExchange as (o: { withSigner?: boolean }) => unknown)({ withSigner: false });
    const ex = (ctx as { exchange?: { setSigner?: unknown; walletAddress?: unknown } }).exchange;
    const hasSetSigner = typeof ex?.setSigner === "function";
    console.log(`  ${hasSetSigner ? "ok  " : "MISS"}  exchange.setSigner`);
    if (!hasSetSigner) missing++;
    // Bind a throwaway account and check the exchange reports it. Nothing is
    // signed and nothing is sent; this only proves the wiring exists.
    if (hasSetSigner) {
      const { privateKeyToAccount, generatePrivateKey } = await import("viem/accounts");
      const account = privateKeyToAccount(generatePrivateKey());
      (ex as { setSigner: (s: { account: unknown }) => void }).setSigner({ account });
      const bound = String((ctx as { exchange: { walletAddress?: string } }).exchange.walletAddress ?? "").toLowerCase();
      const ok = bound === account.address.toLowerCase();
      console.log(`  ${ok ? "ok  " : "MISS"}  a bound viem account becomes the exchange's wallet`);
      if (!ok) missing++;
    }
  } catch (e) {
    console.log(`  MISS  binding a signer threw: ${e instanceof Error ? e.message : String(e)}`);
    missing++;
  }

  console.log("");
  if (missing > 0) {
    console.error(`${missing} check(s) failed — the kit has moved. Update src/runtime/ec-core-types.ts.`);
    process.exitCode = 1;
  } else {
    console.log(`all ${EC_CORE_EXPORTS.length} exports present, and a caller-supplied signer binds.`);
    console.log(`The live executor's contract holds, including per-user signing.`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
