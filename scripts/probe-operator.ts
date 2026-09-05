// `npm run probe:operator` — can Event Contracts be traded non-custodially?
//
// This is the question that decides whether Rivo can ever be a hosted product
// or must stay something you run yourself. A browser wallet authenticates a
// person; it cannot authorise an unattended machine (see src/public/wallet.ts).
// The only way out is an on-chain scoped authority: a hot key that may place and
// cancel orders for an owner and can never move the owner's funds. DreamDEX has
// exactly that shape on SPOT — `placeOrderFor` / `cancelOrderFor`, granted
// through an OperatorPermissionsRegistry (kit docs/session-keys.md).
//
// The kit's Event Contract package has no such path, which is easy to establish
// with grep and easy to dismiss as "not wired up yet". So this asks the chain
// instead of the SDK, because the two disagree: the deployed BinaryPool DOES
// contain `placeBinaryOrderFor` and `cancelOrderFor`.
//
// The method is a differential. A parameter error and a disabled feature both
// look like "it reverted", so neither one alone proves anything:
//
//   1. Place a valid order with `placeBinaryOrder`. It succeeds — so the args,
//      the market, the collateral and the caller are all good.
//   2. Send those SAME args to `placeBinaryOrderFor`.
//   3. Break one parameter at a time on the plain function, and collect the
//      error each produces.
//
// If the pool answered every failure with one generic error, step 3 would come
// back uniform and this would prove nothing. It does not: each parameter has its
// own selector. Against that baseline, a single distinct error shared by both
// on-behalf entrypoints — for every caller tried, including the owner acting for
// itself — is not an authorisation decision. It is the feature being off.
//
// Everything here is `eth_call`. It signs nothing, sends nothing, and needs no
// key: `--owner` is enough, and it defaults to the configured signer's address
// only as a convenience. Findings land in docs/evidence/operator-probe.json so a
// reader can re-run it and compare rather than take our word for it.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadEnv } from "../src/core/env.js";
import { endpoints, network } from "../src/core/config.js";
import { VENUE } from "../src/core/venue.js";
import { Indexer } from "../src/core/indexer.js";

// ---------------------------------------------------------------- the calls
//
// Written as raw selectors and hand-encoded calldata rather than through a
// contract library, because the whole point is to ask the deployed bytecode
// something the SDK's wrapper would not let us ask.

const SELECTORS = {
  placeBinaryOrder: "0x718c2d4d",
  placeBinaryOrderFor: "0x5d97c566",
  cancelOrder: "0xdbc91396",
  cancelOrderFor: "0xe37b444b",
  // The spot-style gate view. Its absence is itself a result: there is no
  // on-chain way to ask a BinaryPool whether an operator is authorised.
  isOperatorAuthorized: "0xa8cb3794",
  // Vault surface — tested because "the owner has no vault balance" was the
  // most plausible innocent explanation for the shared error, and had to go.
  deposit: "0x47e7ef24",
  withdraw: "0xf3fef3a3",
  setManualVaultMode: "0xfc7b1853",
} as const;

const pad = (hex: string) => hex.replace(/^0x/, "").padStart(64, "0").toLowerCase();
const word = (v: bigint | number) => pad(BigInt(v).toString(16));
const addr = (a: string) => pad(a.toLowerCase().replace(/^0x/, ""));

/** ABI-encode `placeBinaryOrder`, optionally in its on-behalf form. */
function encodePlace(o: {
  owner?: string;
  kind: number;
  price: bigint;
  quantity: bigint;
  expiresNs: bigint;
  orderType: number;
}): string {
  const head = o.owner ? SELECTORS.placeBinaryOrderFor : SELECTORS.placeBinaryOrder;
  const args = [
    ...(o.owner ? [addr(o.owner)] : []),
    word(o.kind),
    word(o.price),
    word(o.quantity),
    word(o.expiresNs),
    word(o.orderType),
    word(0), // selfMatchingOption
    addr("0x0000000000000000000000000000000000000000"), // builder
    word(0), // builderFeeBpsTimes1k
    word(0), // userData
  ];
  return head + args.join("");
}

// ------------------------------------------------------------------- rpc

interface CallResult {
  ok: boolean;
  /** The 4-byte custom-error selector, when it reverted with one. */
  error: string | null;
  raw: string | null;
}

async function rpc(url: string, method: string, params: unknown[]): Promise<{ result?: unknown; error?: { message?: string; data?: unknown } }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  return (await res.json()) as { result?: unknown; error?: { message?: string; data?: unknown } };
}

/**
 * `eth_call` with an arbitrary `from`.
 *
 * Impersonation is the reason this probe can be thorough at zero cost: the
 * question "which caller is allowed" is answerable without controlling any of
 * the candidates. A revert's custom-error selector is the first 4 bytes of the
 * returned data, which different nodes bury in different places, so the
 * extraction is deliberately forgiving.
 */
async function call(url: string, from: string, to: string, data: string): Promise<CallResult> {
  const j = await rpc(url, "eth_call", [{ from, to, data }, "latest"]);
  if (j.error) {
    const carrier = j.error.data;
    const hex =
      typeof carrier === "string"
        ? carrier
        : typeof (carrier as { data?: string } | undefined)?.data === "string"
          ? (carrier as { data: string }).data
          : (j.error.message ?? "");
    const sel = /0x[0-9a-fA-F]{8}/.exec(hex)?.[0] ?? null;
    return { ok: false, error: sel ? sel.toLowerCase() : null, raw: typeof hex === "string" ? hex.slice(0, 200) : null };
  }
  return { ok: true, error: null, raw: typeof j.result === "string" ? j.result.slice(0, 200) : null };
}

async function getCode(url: string, address: string): Promise<string> {
  const j = await rpc(url, "eth_getCode", [address, "latest"]);
  return typeof j.result === "string" ? j.result.toLowerCase() : "0x";
}

// ------------------------------------------------------------------- main

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

async function ownerAddress(): Promise<string> {
  const explicit = flag("owner");
  if (explicit) return explicit;
  loadEnv();
  const pk = (process.env.PRIVATE_KEY ?? "").trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    const { privateKeyToAccount } = await import("viem/accounts");
    return privateKeyToAccount(pk as `0x${string}`).address;
  }
  // No key and no flag: any funded venue account works, because nothing is
  // signed. This one is the wallet used in docs/EVIDENCE.md.
  return "0x6730d3a2A217108AB53CCFe60ffdAd05D3C124e5";
}

async function main(): Promise<void> {
  const net = network();
  // The venue table carries the RPC; RPC_URL overrides it, as everywhere else.
  const rpcUrl = process.env.RPC_URL || VENUE[net].rpc;
  const owner = await ownerAddress();
  const out = flag("out") ?? "docs/evidence/operator-probe.json";

  console.log(`\nOPERATOR PROBE — is a non-custodial Event Contract bot possible?`);
  console.log(`  network ${net}   owner ${owner}\n`);

  // A window with enough life left that it cannot expire mid-probe, and the
  // NEAREST such window rather than the furthest.
  //
  // This sorted descending and took the longest-dated window, which is the one
  // least likely to be trading: a 1d contract listed hours ahead has no book, so
  // the valid `placeBinaryOrder` baseline reverted too and the probe could not
  // separate "the on-behalf path is gated" from "nothing works here". It
  // reported INCONCLUSIVE on 2026-09-05 for exactly that reason. The `> now +
  // 900` filter already guarantees the window outlives the probe; among those,
  // the soonest to expire is the one with a live book.
  const idx = new Indexer();
  const now = Math.floor(Date.now() / 1000);
  const live = (await idx.liveMarkets()).filter((m) => m.expiry > now + 900).sort((a, b) => a.expiry - b.expiry);
  const market = live[0];
  if (!market) {
    console.log("  no window with >15 minutes of life — the venue is between series. Try again shortly.");
    process.exit(1);
  }

  // The indexer knows the pool; the kit's address book does not (and its
  // hardcoded implementation address is stale — recorded below).
  const pool = await poolOf(market.marketId);
  if (!pool) {
    console.log("  the indexer did not return a binaryPoolAddress for the chosen market.");
    process.exit(1);
  }
  console.log(`  market  ${market.asset}-${market.intervalSec / 60}m   pool ${pool}`);

  // ---- what is actually deployed, behind the proxy
  const beacon = await beaconOf(rpcUrl, pool);
  const impl = beacon ? await implementationOf(rpcUrl, beacon) : null;
  const code = impl ? await getCode(rpcUrl, impl) : "0x";
  console.log(`  beacon  ${beacon ?? "—"}\n  impl    ${impl ?? "—"}  ${(code.length - 2) / 2} bytes\n`);

  const present: Record<string, boolean> = {};
  for (const [name, sel] of Object.entries(SELECTORS)) {
    present[name] = code.includes(sel.slice(2));
    console.log(`    ${present[name] ? "PRESENT" : "absent "}  ${sel}  ${name}`);
  }

  // ---- the differential
  const expiresAt = Math.min(now + 120, market.expiry);
  const valid = { kind: 0, price: 100_000n, quantity: 1_000_000n, expiresNs: BigInt(expiresAt) * 1_000_000_000n, orderType: 3 };

  console.log(`\n  BUY_YES 1 share @ 0.10, POST_ONLY, expiring in ${expiresAt - now}s\n`);

  const baseline: Record<string, CallResult> = {
    "placeBinaryOrder — valid": await call(rpcUrl, owner, pool, encodePlace(valid)),
    "placeBinaryOrder — price = 0": await call(rpcUrl, owner, pool, encodePlace({ ...valid, price: 0n })),
    "placeBinaryOrder — price >= 1": await call(rpcUrl, owner, pool, encodePlace({ ...valid, price: 2_000_000n })),
    "placeBinaryOrder — quantity = 0": await call(rpcUrl, owner, pool, encodePlace({ ...valid, quantity: 0n })),
    "placeBinaryOrder — expiry = 0": await call(rpcUrl, owner, pool, encodePlace({ ...valid, expiresNs: 0n })),
  };
  for (const [label, r] of Object.entries(baseline)) {
    console.log(`    ${label.padEnd(34)} ${r.ok ? "OK" : `revert ${r.error ?? "?"}`}`);
  }

  // Every plausible caller, asked the same question.
  const callers: [string, string][] = [
    ["the owner itself", owner],
    ["an unrelated address", "0x000000000000000000000000000000000000dEaD"],
    ["binaryModule", "0x3ecC694Cef705358864a646142ac17A90E29e388"],
    ["collateralRouter", "0xbC0C9834B15ACE38bB50dDaa7d7f7C7CC4DC183C"],
    ["marketsCore", "0x2802504314685D89bF6C992CA5a8e7cC78bc0294"],
    ["binarySettlement", "0xbF4a49e0Dfd092e5FBE8E5761064C49533e6Ed23"],
    ["the pool itself", pool],
  ];
  // ---- name the selectors
  //
  // A page of raw 4-byte hex is not evidence anybody can check. These are the
  // pool's own custom errors, decoded against the ABI the SDK already ships in
  // `contractErrorsAbi` — which is the point of SDK-FEEDBACK #4: the names exist
  // and simply never reach a caller.
  const ERROR_NAMES: Record<string, string> = {
    "0x3fb0ba2e": "OnlyApprovedContracts()",
    "0xfb8f41b2": "ERC20InsufficientAllowance(address,uint256,uint256)",
    "0xaf608abb": "InvalidPrice(uint256,uint256)",
    "0xeaa68ceb": "QuantityBelowMinimum(uint256,uint256)",
    "0x7cf05fcb": "PostOnlyWouldCross()",
    "0x3154078e": "OrderAlreadyExpired()",
  };
  const named = (sel?: string | null): string => (sel ? (ERROR_NAMES[sel] ? `${sel} ${ERROR_NAMES[sel]}` : sel) : "?");

  console.log();
  const onBehalf: Record<string, CallResult> = {};
  for (const [label, from] of callers) {
    const r = await call(rpcUrl, from, pool, encodePlace({ ...valid, owner }));
    onBehalf[label] = r;
    console.log(`    placeBinaryOrderFor from ${label.padEnd(22)} ${r.ok ? "OK" : `revert ${named(r.error)}`}`);
  }
  const cancelFor = await call(rpcUrl, owner, pool, SELECTORS.cancelOrderFor + addr(owner) + word(1));
  console.log(`    cancelOrderFor      from ${"the owner itself".padEnd(22)} ${cancelFor.ok ? "OK" : `revert ${named(cancelFor.error)}`}`);

  // ---- the reading
  const paramErrors = Object.entries(baseline).filter(([, r]) => !r.ok).map(([, r]) => r.error);
  const distinctParamErrors = new Set(paramErrors.filter(Boolean)).size;
  const forErrors = new Set([...Object.values(onBehalf), cancelFor].filter((r) => !r.ok).map((r) => r.error).filter(Boolean));
  const singleForError = forErrors.size === 1 ? [...forErrors][0]! : null;
  const anyForSucceeded = [...Object.values(onBehalf), cancelFor].some((r) => r.ok);

  // A blocked baseline does not blind the probe.
  //
  // This used to demand `placeBinaryOrder — valid` succeed before it would read
  // anything, and on 2026-09-05 that produced INCONCLUSIVE for a reason with
  // nothing to do with the question: the owner held no allowance to that
  // window's pool, so the baseline reverted ERC20InsufficientAllowance. The
  // on-behalf answer was unchanged and unambiguous underneath it.
  //
  // What actually carries the finding is the CONTRAST: the pool answers wrong
  // parameters with several different named errors, and answers every on-behalf
  // call — from every caller, including the owner itself — with one and the same
  // error. That contrast holds whether or not the baseline can pay.
  const baselineOk = baseline["placeBinaryOrder — valid"]?.ok === true;
  const baselineBlockedOnCollateral =
    !baselineOk && baseline["placeBinaryOrder — valid"]?.error === "0xfb8f41b2";

  const verdict = anyForSucceeded
    ? "POSSIBLE — an on-behalf call succeeded; a non-custodial authority can be built on it."
    : singleForError && distinctParamErrors >= 3
      ? `DISABLED — every on-behalf call returns ${named(singleForError)}, from every caller including the owner, while parameter errors are ${distinctParamErrors} distinct selectors. Compiled in, switched off.` +
        (baselineOk
          ? ""
          : baselineBlockedOnCollateral
            ? " (The valid-order baseline reverted ERC20InsufficientAllowance — this wallet has no allowance to this window's pool yet. That gates the baseline, not the on-behalf path: the pool still distinguishes parameter faults by name while answering every on-behalf caller alike.)"
            : ` (The valid-order baseline reverted ${named(baseline["placeBinaryOrder — valid"]?.error)}; the on-behalf contrast below stands on its own.)`)
      : "INCONCLUSIVE — the pool did not distinguish parameter faults, so nothing can be concluded about the on-behalf path. Re-run against a livelier window.";

  console.log(`\n  VERDICT  ${verdict}\n`);

  const report = {
    generatedAt: new Date().toISOString(),
    network: net,
    question: "Can an Event Contract order be placed by one key on another account's behalf?",
    method:
      "Differential eth_call. A valid order via placeBinaryOrder establishes that args, market and caller are good; the same args via placeBinaryOrderFor isolate the on-behalf path; breaking one parameter at a time establishes that the pool distinguishes failures rather than answering everything alike.",
    market: { marketId: market.marketId, asset: market.asset, intervalSec: market.intervalSec, expiry: market.expiry, pool },
    deployment: {
      beacon,
      implementation: impl,
      bytes: (code.length - 2) / 2,
      note: "ec-core's addresses.ts hardcodes binaryPoolImpl 0x82A1FcdaA2daC2fC7D5f9909D43E68021eE966FD, which is not what the beacon resolves to.",
      selectors: Object.fromEntries(Object.entries(SELECTORS).map(([k, v]) => [k, { selector: v, present: present[k] ?? false }])),
    },
    baseline: Object.fromEntries(Object.entries(baseline).map(([k, v]) => [k, v.ok ? "ok" : v.error])),
    onBehalf: Object.fromEntries(
      [...Object.entries(onBehalf), ["cancelOrderFor from the owner itself", cancelFor] as [string, CallResult]].map(([k, v]) => [k, v.ok ? "ok" : v.error]),
    ),
    errorNames: ERROR_NAMES,
    distinctParameterErrors: distinctParamErrors,
    sharedOnBehalfError: singleForError,
    sharedOnBehalfErrorName: singleForError ? (ERROR_NAMES[singleForError] ?? null) : null,
    verdict,
    reproduce: "npm run probe:operator -- --owner <any funded venue address>",
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
  console.log(`  written to ${out}\n`);
}

/** The pool address for a market — an indexer field the kit does not surface. */
async function poolOf(marketId: string): Promise<string | null> {
  const { indexer } = endpoints();
  const res = await fetch(indexer, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: `query{ Market(where:{marketId:{_eq:"${marketId}"}}, limit:1){ binaryPoolAddress } }` }),
    signal: AbortSignal.timeout(20_000),
  });
  const j = (await res.json()) as { data?: { Market?: { binaryPoolAddress?: string }[] } };
  return j.data?.Market?.[0]?.binaryPoolAddress ?? null;
}

/**
 * The beacon a pool proxy delegates to.
 *
 * These pools are not EIP-1967 — the implementation slot is empty. The proxy
 * instead carries its beacon as an immutable, so the address is read out of the
 * runtime bytecode: the constructor-injected 32-byte word that precedes the
 * `implementation()` staticcall. Recovering it by scanning for a push of a
 * plausible address is crude, so it is verified before use.
 */
async function beaconOf(rpcUrl: string, pool: string): Promise<string | null> {
  const code = await getCode(rpcUrl, pool);
  for (const m of code.matchAll(/7f([0-9a-f]{64})/g)) {
    const w = m[1]!;
    if (!/^0{24}/.test(w)) continue;
    const candidate = "0x" + w.slice(24);
    if (/^0x0+$/.test(candidate)) continue;
    if ((await getCode(rpcUrl, candidate)) !== "0x") return candidate;
  }
  return null;
}

/** `implementation()` on the beacon. */
async function implementationOf(rpcUrl: string, beacon: string): Promise<string | null> {
  const r = await rpc(rpcUrl, "eth_call", [{ to: beacon, data: "0x5c60da1b" }, "latest"]);
  const hex = typeof r.result === "string" ? r.result : "";
  return hex.length >= 66 ? "0x" + hex.slice(-40) : null;
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
