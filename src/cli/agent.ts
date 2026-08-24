// `npm run agent` — the wallet Rivo trades with, and how much it may lose.
//
// The venue offers no on-chain scoping for Event Contracts (see signer.ts, and
// `npm run probe:operator` for the measurement), so an unattended process must
// hold a key that can do whatever its account can do. That leaves exactly one
// honest lever: make sure the account cannot do much.
//
// An agent wallet is a keypair Rivo generates and keeps beside the process. The
// owner moves a chosen float into it and sweeps it back when they are done.
// Nothing else ever lands there — no other assets, no allowance pointing at the
// owner's wallet, no way to pull more. So the worst case is not "a bot with your
// private key"; it is "a bot with 25 tUSDC", and 25 is a number the owner chose.
//
//   npm run agent -- new                          create the key
//   npm run agent -- status                       address, balances, exposure
//   npm run agent -- fund --collateral 25 --gas 1 move a float in, from .env
//   npm run agent -- sweep                        send everything back
//
// `fund` and `sweep` are the only commands that need the owner's key, and they
// use it for plain transfers, never for trading. Everything Rivo does afterwards
// is signed by the agent.

import { mkdirSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { loadEnv } from "../core/env.js";
import { network, COLLATERAL_TOKEN, collateralName } from "../core/config.js";
import { gasTokenName, VENUE } from "../core/venue.js";
import { AgentWalletAuthority } from "../runtime/signer.js";

const args = process.argv.slice(2);
const cmd = args.find((a) => !a.startsWith("--")) ?? "status";
const num = (name: string, fallback: number): number => {
  const i = args.indexOf(`--${name}`);
  const v = i >= 0 ? Number(args[i + 1]) : NaN;
  return Number.isFinite(v) && v >= 0 ? v : fallback;
};
const has = (name: string) => args.includes(`--${name}`);

const net = network();
const rpcUrl = process.env.RPC_URL || VENUE[net].rpc;
const chain = {
  id: VENUE[net].chainId,
  name: VENUE[net].chainName,
  nativeCurrency: { name: gasTokenName(net), symbol: gasTokenName(net), decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
} as const;
const gasSymbol = chain.nativeCurrency.symbol;
const token = (process.env.COLLATERAL_TOKEN ?? COLLATERAL_TOKEN[net]) as `0x${string}`;
const decimals = net === "mainnet" ? 18 : 6;
const one = 10n ** BigInt(decimals);

const fmt = (raw: bigint, dp: number): string => (Number(raw) / 10 ** dp).toFixed(dp === 18 ? 4 : 2);

async function viem() {
  const [core, accounts] = await Promise.all([import("viem"), import("viem/accounts")]);
  return { ...core, ...accounts };
}

const ERC20 = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

async function balances(address: `0x${string}`): Promise<{ gas: bigint; collateral: bigint }> {
  const { createPublicClient, http } = await viem();
  const client = createPublicClient({ chain, transport: http(rpcUrl) });
  const [gas, collateral] = await Promise.all([
    client.getBalance({ address }),
    client.readContract({ address: token, abi: ERC20, functionName: "balanceOf", args: [address] }).catch(() => 0n),
  ]);
  return { gas, collateral: collateral as bigint };
}

/**
 * The owner key from `.env` — used for transfers only.
 *
 * Deliberately separate from `authority()`, which by now prefers the agent
 * wallet: asking that for a key here would hand back the agent's own and
 * "funding" would move money from the agent to itself.
 */
async function ownerAccount() {
  loadEnv();
  const pk = (process.env.PRIVATE_KEY ?? "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) return null;
  const { privateKeyToAccount } = await viem();
  return privateKeyToAccount(pk as `0x${string}`);
}

async function agentAccount() {
  const auth = new AgentWalletAuthority();
  if (!auth.available()) return null;
  const { privateKeyToAccount } = await viem();
  return privateKeyToAccount(auth.key() as `0x${string}`);
}

// ------------------------------------------------------------------- new

async function cmdNew(): Promise<void> {
  const path = AgentWalletAuthority.path();
  if (existsSync(path) && !has("force")) {
    console.log(`\n  A key already exists at ${path}.`);
    console.log(`  Refusing to overwrite it — if it holds a float, that float would become unreachable.`);
    console.log(`  Sweep it first (\`npm run agent -- sweep\`), or pass --force if you are certain.\n`);
    process.exit(1);
  }
  const { generatePrivateKey, privateKeyToAccount } = await viem();
  const key = generatePrivateKey();
  const account = privateKeyToAccount(key);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, key + "\n", { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows and some mounts have no concept of this; the warning below covers it.
  }
  console.log(`\n  agent wallet  ${account.address}`);
  console.log(`  key file      ${path}  (mode 600, gitignored)`);
  console.log(`\n  It holds nothing yet. Give it a float:`);
  console.log(`    npm run agent -- fund --collateral 25 --gas 1\n`);
  console.log(`  Rivo will sign with this key from now on. Your .env key stays untouched,`);
  console.log(`  and is used only to move funds in and out.\n`);
}

// ---------------------------------------------------------------- status

async function cmdStatus(): Promise<void> {
  const agent = await agentAccount();
  const owner = await ownerAccount();
  console.log(`\n  network   ${net}`);
  if (!agent) {
    console.log(`\n  No agent wallet at ${AgentWalletAuthority.path()}.`);
    console.log(`  Rivo would sign with the raw key in .env — full account authority.`);
    console.log(`  Create one:  npm run agent -- new\n`);
    return;
  }
  const a = await balances(agent.address);
  console.log(`  agent     ${agent.address}`);
  console.log(`            ${fmt(a.gas, 18)} ${gasSymbol}   ${fmt(a.collateral, decimals)} ${collateralName(net)}`);
  if (owner) {
    const o = await balances(owner.address);
    console.log(`  owner     ${owner.address}`);
    console.log(`            ${fmt(o.gas, 18)} ${gasSymbol}   ${fmt(o.collateral, decimals)} ${collateralName(net)}`);
  }
  console.log(`\n  Maximum loss if this machine is compromised: ${fmt(a.collateral, decimals)} ${collateralName(net)}`);
  console.log(`  plus ${fmt(a.gas, 18)} ${gasSymbol} of gas. The agent holds no other assets and`);
  console.log(`  has no allowance against the owner's wallet.\n`);
  console.log(`  explorer  ${VENUE[net].explorer}/address/${agent.address}\n`);
}

// ------------------------------------------------------------------ fund

async function cmdFund(): Promise<void> {
  const agent = await agentAccount();
  if (!agent) {
    console.log(`\n  No agent wallet yet — run \`npm run agent -- new\` first.\n`);
    process.exit(1);
  }
  const owner = await ownerAccount();
  if (!owner) {
    console.log(`\n  Funding moves value from your own wallet, so it needs PRIVATE_KEY in .env.\n`);
    process.exit(1);
  }
  const wantCollateral = num("collateral", 25);
  const wantGas = num("gas", 1);
  const { createWalletClient, createPublicClient, http, parseUnits, parseEther } = await viem();
  const pub = createPublicClient({ chain, transport: http(rpcUrl) });
  const wallet = createWalletClient({ account: owner, chain, transport: http(rpcUrl) });

  const before = await balances(owner.address);
  const collateralRaw = parseUnits(String(wantCollateral), decimals);
  const gasRaw = parseEther(String(wantGas));
  if (before.collateral < collateralRaw) {
    console.log(`\n  Owner holds ${fmt(before.collateral, decimals)} ${collateralName(net)}, less than the ${wantCollateral} requested.`);
    console.log(`  On testnet: npm run faucet\n`);
    process.exit(1);
  }

  console.log(`\n  owner ${owner.address}\n  agent ${agent.address}\n`);
  if (gasRaw > 0n) {
    const hash = await wallet.sendTransaction({ to: agent.address, value: gasRaw });
    const rec = await pub.waitForTransactionReceipt({ hash });
    console.log(`  gas         ${wantGas} ${gasSymbol}  ${rec.status}  ${hash}`);
  }
  if (collateralRaw > 0n) {
    const hash = await wallet.writeContract({ address: token, abi: ERC20, functionName: "transfer", args: [agent.address, collateralRaw] });
    const rec = await pub.waitForTransactionReceipt({ hash });
    console.log(`  collateral  ${wantCollateral} ${collateralName(net)}  ${rec.status}  ${hash}`);
  }
  const after = await balances(agent.address);
  console.log(`\n  agent now holds ${fmt(after.collateral, decimals)} ${collateralName(net)} and ${fmt(after.gas, 18)} ${gasSymbol}.`);
  console.log(`  That is the ceiling on what Rivo can lose. Start it with:`);
  console.log(`    npm start -- --capital ${Math.floor(Number(after.collateral) / Number(one))} --profile balanced --live\n`);
}

// ----------------------------------------------------------------- sweep

async function cmdSweep(): Promise<void> {
  const agent = await agentAccount();
  if (!agent) {
    console.log(`\n  No agent wallet to sweep.\n`);
    process.exit(1);
  }
  const owner = await ownerAccount();
  const to = (args.includes("--to") ? args[args.indexOf("--to") + 1] : owner?.address) as `0x${string}` | undefined;
  if (!to) {
    console.log(`\n  Nowhere to sweep to: set PRIVATE_KEY in .env, or pass --to 0x…\n`);
    process.exit(1);
  }
  const { createWalletClient, createPublicClient, http } = await viem();
  const pub = createPublicClient({ chain, transport: http(rpcUrl) });
  const wallet = createWalletClient({ account: agent, chain, transport: http(rpcUrl) });
  const bal = await balances(agent.address);
  console.log(`\n  sweeping ${agent.address} -> ${to}\n`);

  if (bal.collateral > 0n) {
    const hash = await wallet.writeContract({ address: token, abi: ERC20, functionName: "transfer", args: [to, bal.collateral] });
    const rec = await pub.waitForTransactionReceipt({ hash });
    console.log(`  collateral  ${fmt(bal.collateral, decimals)} ${collateralName(net)}  ${rec.status}  ${hash}`);
  } else {
    console.log(`  collateral  nothing to sweep`);
  }

  // Native last, and never all of it: the transfer above still has to be paid
  // for, and a wallet swept to exactly zero cannot send the transaction that
  // would empty it. Leave a gas reserve rather than bricking the account.
  const left = await pub.getBalance({ address: agent.address });
  const gasPrice = await pub.getGasPrice();
  const reserve = gasPrice * 21_000n * 4n;
  if (left > reserve) {
    const hash = await wallet.sendTransaction({ to, value: left - reserve });
    const rec = await pub.waitForTransactionReceipt({ hash });
    console.log(`  gas         ${fmt(left - reserve, 18)} ${gasSymbol}  ${rec.status}  ${hash}`);
    console.log(`\n  A gas reserve of ${fmt(reserve, 18)} ${gasSymbol} is left behind on purpose, so the wallet`);
    console.log(`  stays usable. The key file is untouched — delete it yourself if you are done.\n`);
  } else {
    console.log(`  gas         below the reserve, left in place\n`);
  }
}

async function main(): Promise<void> {
  switch (cmd) {
    case "new":
      return cmdNew();
    case "fund":
      return cmdFund();
    case "sweep":
      return cmdSweep();
    case "status":
      return cmdStatus();
    default:
      console.log(`\n  unknown command "${cmd}" — try: new | status | fund | sweep\n`);
      process.exit(1);
  }
}

main().catch((e: unknown) => {
  console.error(`\n  ${e instanceof Error ? e.message.split("\n")[0] : String(e)}\n`);
  process.exit(1);
});
