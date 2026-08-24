// `npm run approve` — let the pools pull collateral.
//
// The pool that escrows collateral needs an ERC-20 allowance, and nothing in
// `ec-core` or `@somnia-chain/markets-sdk` grants one for event contracts. The
// spot half of the kit does exactly this before every order
// (`packages/core/src/execute.ts` → `ensureAllowance(ctx, token, pool, amount)`);
// the event-contract half has no equivalent, so a fresh wallet's first order
// reverts with `placeBinaryOrder reverted: for an unknown reason`.
//
// THIS COMMAND IS OPTIONAL. The runtime approves pools by itself, inline, the
// first time it needs one — autonomy is the product, and a manager that needs a
// human to stop it, approve a pool and restart it is not one.
//
// It survives as a warm-up. Approving costs a transaction and a round trip, and
// paying that in the middle of a cycle means paying it exactly when an edge is
// disappearing. Running this before a session gets it out of the way.
//
// A note on what we got wrong, since the opposite is easy to assume: we first
// believed an inline approval would race the SDK's own nonce tracker, because
// the kit warns about precisely that for its claim sweep. Measured, it does not
// — waiting for the approval receipt before placing is enough. The reverts that
// prompted the theory were the venue's lot granularity, present in both runs
// being compared.

import { maxUint256 } from "viem";
import { loadEnv } from "../src/core/env.js";
import { collateralName, COLLATERAL_TOKEN, network } from "../src/core/config.js";
import { Indexer } from "../src/core/indexer.js";
import { chainIdOf, rpcUrl } from "../src/core/venue.js";
import { AllowanceManager } from "../src/runtime/allowance.js";

async function main(): Promise<void> {
  loadEnv();
  const net = network();
  const pk = (process.env.PRIVATE_KEY ?? "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    console.error("PRIVATE_KEY is not a valid 32-byte key — nothing to sign with.");
    process.exitCode = 1;
    return;
  }
  if (process.argv.includes("--check")) console.log("(check only — nothing will be sent)\n");

  const idx = new Indexer();
  const mgr = new AllowanceManager({
    rpcUrl: rpcUrl(net, process.env.RPC_URL),
    chainId: chainIdOf(net),
    privateKey: pk,
    token: (process.env.COLLATERAL_TOKEN ?? COLLATERAL_TOKEN[net]) as `0x${string}`,
  });

  console.log(`wallet   ${mgr.address}`);
  console.log(`token    ${COLLATERAL_TOKEN[net]}  (${collateralName(net)})`);
  console.log("");

  const live = await idx.liveMarkets();
  const pools = await poolsFor(idx, live.map((m) => m.marketId));
  if (pools.size === 0) {
    console.log("tidak ada pool live untuk di-approve.");
    return;
  }

  let approved = 0;
  let already = 0;
  for (const [pool, label] of pools) {
    const current = await mgr.allowanceFor(pool as `0x${string}`);
    if (current >= maxUint256 / 2n) {
      console.log(`  ok      ${label.padEnd(12)} ${pool.slice(0, 12)}…  sudah unlimited`);
      already++;
      continue;
    }
    if (process.argv.includes("--check")) {
      console.log(`  PERLU   ${label.padEnd(12)} ${pool.slice(0, 12)}…  allowance ${current}`);
      continue;
    }
    process.stdout.write(`  approve ${label.padEnd(12)} ${pool.slice(0, 12)}… `);
    // Sequential on purpose: one signer, one nonce at a time.
    const hash = await mgr.ensure(pool as `0x${string}`, maxUint256 / 2n);
    console.log(hash ? `tx ${hash.slice(0, 18)}…` : "sudah cukup");
    approved++;
  }

  console.log("");
  console.log(`${already} pool sudah siap, ${approved} baru di-approve.`);
  if (approved > 0) console.log("Jalankan lagi setelah window baru muncul — pool didaur ulang, tapi yang baru butuh approval sendiri.");
}

/** Pool address per live market, labelled for a human. */
async function poolsFor(idx: Indexer, marketIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (marketIds.length === 0) return out;
  const res = await fetch(process.env.RIVO_INDEXER_URL ?? "https://dev.smk.somnia.host/v1/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: `query($ids:[String!]){ Market(where:{marketId:{_in:$ids}}, limit:100){ poolAddress asset intervalSec } }`,
      variables: { ids: marketIds.map((m) => m.toLowerCase()) },
    }),
  });
  const j = (await res.json()) as { data?: { Market: { poolAddress: string; asset: string; intervalSec: string }[] } };
  for (const m of j.data?.Market ?? []) {
    if (m.poolAddress) out.set(m.poolAddress, `${m.asset}-${Math.round(Number(m.intervalSec) / 60)}m`);
  }
  void idx;
  return out;
}

main().catch((e) => {
  console.error(`approve gagal: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
