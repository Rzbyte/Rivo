import { loadEnv } from "./src/core/env.js";
import { PrivyDelegatedAuthority } from "./src/signing/privy.js";
const W = { walletId: "rjy63p1dc69rqoqrs6itpfz0", address: "0x1B4B0195b32053489992649813Dc02fc5e282E2E" as const };
async function m(){ loadEnv();
  console.log("mencoba tanda tangan server-side untuk wallet USER, tanpa delegasi…");
  try {
    const a = await new PrivyDelegatedAuthority(W, true).account();
    console.log("  account dibuat:", a.address);
    const raw = await a.signTransaction!({ to: W.address, value: 0n, chainId: 50312, nonce: 0,
      gas: 21000n, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, type: "eip1559" } as never);
    console.log("  BERHASIL tanda tangan:", String(raw).slice(0,30)+"…");
    console.log("  -> delegasi TIDAK dibutuhkan, atau sudah ada");
  } catch (e) {
    console.log("  DITOLAK:", (e instanceof Error ? e.message : String(e)).slice(0,140));
    console.log("  -> delegasi memang wajib; alur browser harus jalan");
  }
  process.exit(0);
}
m().catch(e=>{console.error(e);process.exit(1)});
