// `npm run doctor` — can Rivo actually trade right now, and if not, what is missing?
//
// Live trading needs four things that fail in four different ways, and three of
// them fail silently: a signer, gas, collateral, and a venue with live windows.
// Finding out which one is absent by watching a bot do nothing is a bad use of
// an afternoon, so this asks all four directly and says which to fix.
//
// It never prints a private key, and it sends nothing.

import { existsSync, readFileSync } from "node:fs";
import { Indexer } from "../src/core/indexer.js";
import { collateralName, COLLATERAL_TOKEN, endpoints, network } from "../src/core/config.js";

const ok = (s: string) => `  ok    ${s}`;
const warn = (s: string) => `  warn  ${s}`;
const bad = (s: string) => `  MISS  ${s}`;

/** Load .env without a dependency, and without echoing anything sensitive. */
function loadEnv(): void {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, k, v] = m;
    if (k && v !== undefined && !process.env[k]) process.env[k] = v.replace(/^["']|["']$/g, "");
  }
}

/**
 * The address behind the configured key.
 *
 * Preferred route is `ec-core` itself, because that is exactly how the live
 * executor learns its own address — so getting a result here proves that path
 * works rather than merely proving the key parses. viem is a fallback for when
 * the kit is absent but happens to be resolvable anyway.
 */
async function deriveAddress(pk: string): Promise<{ address: string; via: string } | null> {
  try {
    const core = (await import("@dreamdex-bot-kit/ec-core")) as {
      createExchange: (o: { withSigner: boolean }) => { exchange?: { walletAddress?: string } };
    };
    const ctx = core.createExchange({ withSigner: true });
    const a = ctx.exchange?.walletAddress;
    if (a) return { address: a, via: "ec-core (jalur yang sama dipakai eksekusi live)" };
  } catch {
    // fall through — the kit may not be linked
  }
  try {
    const { privateKeyToAccount } = (await import("viem/accounts")) as {
      privateKeyToAccount: (k: `0x${string}`) => { address: string };
    };
    return { address: privateKeyToAccount(pk as `0x${string}`).address, via: "viem" };
  } catch {
    return null;
  }
}

/** Native balance in whole units, via a plain JSON-RPC call. */
async function nativeBalance(rpc: string, address: string): Promise<number | null> {
  try {
    const res = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"] }),
    });
    const j = (await res.json()) as { result?: string };
    return j.result ? Number(BigInt(j.result)) / 1e18 : null;
  } catch {
    return null;
  }
}

/** ERC-20 balanceOf, hand-encoded so this needs no ABI and no library. */
async function erc20Balance(rpc: string, token: string, address: string, decimals: number): Promise<number | null> {
  try {
    const data = `0x70a08231${address.replace(/^0x/, "").toLowerCase().padStart(64, "0")}`;
    const res = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: token, data }, "latest"] }),
    });
    const j = (await res.json()) as { result?: string };
    return j.result && j.result !== "0x" ? Number(BigInt(j.result)) / 10 ** decimals : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  loadEnv();
  const net = network();
  const ep = endpoints(net);
  const idx = new Indexer();
  const rpc = process.env.RPC_URL ?? (net === "mainnet" ? "https://api.infra.mainnet.somnia.network" : "https://api.infra.testnet.somnia.network");

  console.log("RIVO · doctor");
  console.log("=".repeat(72));
  console.log(`network    ${net}   collateral decimals ${idx.decimals}`);
  console.log(`venue      ${idx.venueId.slice(0, 20)}…`);
  console.log("");

  let blockers = 0;

  // --- 1. venue -----------------------------------------------------------
  console.log("VENUE");
  try {
    const live = await idx.liveMarkets();
    if (live.length > 0) {
      console.log(ok(`${live.length} window live: ${[...new Set(live.map((m) => `${m.asset}-${Math.round(m.intervalSec / 60)}m`))].join(", ")}`));
    } else {
      console.log(warn("indexer melaporkan 0 window live — venue id mungkin sudah pindah (lihat .env.example)"));
    }
  } catch (e) {
    console.log(bad(`indexer tidak terjangkau: ${e instanceof Error ? e.message : String(e)}`));
    blockers++;
  }

  // --- 2. price feed ------------------------------------------------------
  try {
    const s = await idx.latestSpot("BTC");
    console.log(ok(`price feed hidup — BTC ${s.spot.toFixed(2)}, umur ${Math.max(0, Math.floor(Date.now() / 1000) - s.at)}s`));
  } catch (e) {
    console.log(bad(`price feed: ${e instanceof Error ? e.message : String(e)} — tanpa ini tak ada fair value`));
    blockers++;
  }

  // --- 3. signer ----------------------------------------------------------
  console.log("");
  console.log("SIGNER");
  const pk = (process.env.PRIVATE_KEY ?? "").trim();
  let address: string | null = process.env.RIVO_ADDRESS ?? null;
  if (!pk) {
    console.log(bad("PRIVATE_KEY belum di-set di .env — Rivo akan tetap dry run"));
    blockers++;
  } else if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    console.log(bad(`PRIVATE_KEY bukan kunci 32-byte yang valid (panjang ${pk.length}) — placeholder seperti 0x... ditolak`));
    blockers++;
  } else {
    const derived = await deriveAddress(pk);
    if (derived) {
      address = derived.address;
      console.log(ok(`kunci valid → ${derived.address}`));
      console.log(`        via ${derived.via}`);
    } else {
      console.log(warn("kunci valid, tapi alamatnya tak bisa diturunkan — jalankan `npm run link:kit`"));
      if (address) console.log(ok(`memakai RIVO_ADDRESS=${address}`));
    }
  }

  // --- 4. funding ---------------------------------------------------------
  console.log("");
  console.log("SALDO");
  if (!address) {
    console.log(warn("alamat belum diketahui — set PRIVATE_KEY, atau RIVO_ADDRESS untuk mengecek saldo saja"));
  } else {
    const gas = await nativeBalance(rpc, address);
    if (gas === null) console.log(warn("saldo gas tak terbaca"));
    else if (gas <= 0) {
      console.log(bad(`gas ${gas} STT — ambil dari faucet, tanpa ini tak satu transaksi pun bisa dikirim`));
      blockers++;
    } else if (gas < 0.05) console.log(warn(`gas ${gas.toFixed(4)} STT — tipis, isi lagi sebelum menjalankan lama`));
    else console.log(ok(`gas ${gas.toFixed(4)} STT`));

    const collateralToken = process.env.COLLATERAL_TOKEN ?? COLLATERAL_TOKEN[net];
    const col = await erc20Balance(rpc, collateralToken, address, idx.decimals);
    const name = collateralName(net);
    if (col === null) {
      console.log(warn(`saldo ${name} tak terbaca (token ${collateralToken ?? "tidak diketahui"}) — set COLLATERAL_TOKEN kalau alamatnya berbeda`));
    } else if (col <= 0) {
      console.log(bad(`${name} 0 — INI collateral-nya. STT hanya untuk gas; tanpa ${name} tak ada kontrak yang bisa dibeli`));
      if (net === "testnet") console.log(`        token ${collateralToken} punya faucet(uint256) publik`);
      blockers++;
    } else {
      console.log(ok(`${name} ${col.toFixed(2)}`));
    }

    // Anything already held or owed, which changes what a first run should do.
    try {
      const bal = await idx.outcomeBalances(address);
      if (bal.size > 0) {
        console.log(ok(`${bal.size} leg sudah dipegang on-chain — rekonsiliasi akan mengadopsi/melaporkannya`));
        for (const [k, v] of [...bal].slice(0, 4)) console.log(`          ${k.slice(-18)}  ${v.toFixed(2)}`);
      } else {
        console.log(ok("belum ada posisi on-chain — mulai dari nol"));
      }
    } catch {
      console.log(warn("saldo outcome tak terbaca"));
    }
  }

  // --- 5. bot kit ---------------------------------------------------------
  console.log("");
  console.log("BOT KIT (hanya untuk eksekusi live)");
  try {
    const mod = (await import("@dreamdex-bot-kit/ec-core")) as Record<string, unknown>;
    const missing = ["createExchange", "activeMarkets", "placeLimit", "maybeClaim"].filter((n) => typeof mod[n] !== "function");
    if (missing.length === 0) console.log(ok("ec-core terpasang, export yang dipakai lengkap"));
    else {
      console.log(bad(`ec-core ada tapi kurang: ${missing.join(", ")}`));
      blockers++;
    }
  } catch {
    console.log(bad("ec-core belum terpasang — clone kit di sebelah repo lalu `npm run link:kit`"));
    blockers++;
  }

  // --- verdict ------------------------------------------------------------
  console.log("");
  console.log("=".repeat(72));
  const dryRun = (process.env.DRY_RUN ?? "true") !== "false";
  if (blockers === 0 && !dryRun) {
    console.log("SIAP LIVE. Mulai kecil: `npm start -- --capital 5 --profile conservative`");
  } else if (blockers === 0) {
    console.log("Semua siap, tapi DRY_RUN masih true — itu default yang benar.");
    console.log("Set DRY_RUN=false di .env kalau memang mau mengirim order sungguhan.");
  } else {
    console.log(`${blockers} hal memblokir eksekusi live. Sampai beres, Rivo tetap dry run —`);
    console.log("dan setiap perintah read-only (calibrate, scan, allocate, backtest) tetap jalan.");
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`doctor gagal: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
