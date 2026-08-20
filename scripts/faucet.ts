// `npm run faucet` — mint testnet collateral.
//
// Rivo buys Event Contracts by crossing the book with collateral, which never
// touches ec-core's `seedInventory` and so never hits the faucet that lives
// inside it. A wallet with gas and no tUSDC therefore runs perfectly and buys
// nothing, which is the failure the doctor exists to name and this exists to fix.
//
// THIS SENDS A TRANSACTION. It is the only script in the repo that does anything
// other than read, and it refuses to run anywhere but testnet.

import { collateralName, COLLATERAL_TOKEN, network } from "../src/core/config.js";
import { loadEnv } from "../src/core/env.js";
import { Indexer } from "../src/core/indexer.js";

async function balanceOf(rpc: string, token: string, who: string, decimals: number): Promise<number | null> {
  const data = `0x70a08231${who.replace(/^0x/, "").toLowerCase().padStart(64, "0")}`;
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: token, data }, "latest"] }),
  });
  const j = (await res.json()) as { result?: string };
  return j.result && j.result !== "0x" ? Number(BigInt(j.result)) / 10 ** decimals : null;
}

async function main(): Promise<void> {
  loadEnv();
  const net = network();
  if (net !== "testnet") {
    // Mainnet collateral is a real stablecoin with no faucet. Failing loudly
    // here is better than a confusing revert.
    console.error(`refusing to run on ${net}: ${collateralName(net)} is a real asset and has no faucet.`);
    process.exitCode = 1;
    return;
  }
  const pk = (process.env.PRIVATE_KEY ?? "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    console.error("PRIVATE_KEY is not a valid 32-byte key — nothing to sign with.");
    process.exitCode = 1;
    return;
  }

  const idx = new Indexer();
  const rpc = process.env.RPC_URL ?? "https://api.infra.testnet.somnia.network";
  const token = process.env.COLLATERAL_TOKEN ?? COLLATERAL_TOKEN[net];
  const name = collateralName(net);

  const core = (await import("@dreamdex-bot-kit/ec-core")) as {
    createExchange: (o: { withSigner: boolean }) => {
      exchange?: { walletAddress?: string; trader?: { faucet?: () => Promise<unknown> } };
    };
  };
  const ctx = core.createExchange({ withSigner: true });
  const me = ctx.exchange?.walletAddress;
  if (!me) {
    console.error("could not resolve the signer's address from ec-core.");
    process.exitCode = 1;
    return;
  }

  const before = await balanceOf(rpc, token, me, idx.decimals);
  console.log(`wallet   ${me}`);
  console.log(`token    ${token}`);
  console.log(`${name} sebelum  ${before === null ? "?" : before.toFixed(2)}`);
  console.log("");
  console.log("mengirim faucet()…");

  const faucet = ctx.exchange?.trader?.faucet;
  if (!faucet) {
    console.error("this SDK build exposes no trader.faucet() — use the web faucet at testnet.somnia.network");
    process.exitCode = 1;
    return;
  }
  await faucet.call(ctx.exchange!.trader);

  // The node confirms in one round trip, but the balance read can still race it.
  // Poll briefly rather than reporting a stale zero and looking like a failure.
  let after = before;
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 1_000));
    after = await balanceOf(rpc, token, me, idx.decimals);
    if (after !== null && (before === null || after > before)) break;
  }
  console.log("");
  console.log(`${name} sesudah  ${after === null ? "?" : after.toFixed(2)}`);
  if (after !== null && before !== null && after > before) {
    console.log(`\nbertambah ${(after - before).toFixed(2)} ${name}. Jalankan \`npm run doctor\` untuk konfirmasi.`);
  } else {
    console.log(`\nsaldo belum berubah — mungkin rate-limited, atau butuh beberapa detik lagi. Cek \`npm run doctor\`.`);
  }
}

main().catch((e) => {
  console.error(`faucet gagal: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
