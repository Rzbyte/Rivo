// Browser wallet connection — EIP-1193, no dependencies.
//
// THE CENTRAL DISTINCTION IN THIS FILE, because getting it wrong is the most
// common dishonesty in an autonomous-trading demo:
//
//   A browser wallet AUTHENTICATES a person. It cannot AUTHORISE an unattended
//   machine.
//
// A wallet signs when a human approves a prompt in a tab that is open. Rivo's
// whole premise is managing a portfolio across settlements that land at 3am, and
// no amount of frontend engineering makes a closed tab sign a transaction. Any
// product that implies otherwise is either round-tripping the user's key to a
// server or quietly not doing what it says.
//
// So the two concerns are kept apart everywhere:
//
//   * This module — identity and read-only chain state. Which address, which
//     network, what it holds. It NEVER requests a signature and never touches a
//     private key, because it never needs to.
//
//   * The execution signer (src/runtime/executor.ts) — a separate key, held by
//     the Rivo backend, that signs the orders. See `signer.ts` for the interface
//     a bounded agent wallet or session key would implement to replace it.
//
// Shadow Mode needs only this module, which is why it runs from a static page
// with nothing installed. Autopilot needs the signer, which is why it needs a
// backend. The UI states that rather than blurring it.

import { COLLATERAL_TOKEN, VENUE, collateralName, gasTokenName, type Network } from "../core/venue.js";
import { timeoutSignal } from "../core/timeout.js";

/** The subset of EIP-1193 we use. Deliberately narrow: no signing methods. */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
}

export interface WalletState {
  address: `0x${string}`;
  chainId: number;
  /** The Rivo network this chain corresponds to, or null when it is neither. */
  network: Network | null;
  /** Native gas balance (STT on testnet), in whole units. */
  gas: number;
  /** DreamDEX collateral balance (tUSDC / USDso), in whole units. */
  collateral: number;
  gasSymbol: string;
  collateralSymbol: string;
}

export class WalletError extends Error {
  constructor(
    readonly code: "NO_PROVIDER" | "REJECTED" | "WRONG_NETWORK" | "RPC",
    message: string,
  ) {
    super(message);
    this.name = "WalletError";
  }
}

/** EIP-1193 rejection. 4001 is the standard "user rejected request". */
const isRejection = (e: unknown): boolean =>
  typeof e === "object" && e !== null && (e as { code?: number }).code === 4001;

export function detectProvider(): Eip1193Provider | null {
  const w = globalThis as { ethereum?: Eip1193Provider };
  return w.ethereum ?? null;
}

/** Which Rivo network a chain id belongs to, or null when the wallet is elsewhere. */
export function networkOf(chainId: number): Network | null {
  for (const net of ["testnet", "mainnet"] as const) if (VENUE[net].chainId === chainId) return net;
  return null;
}

/**
 * Prompt for accounts. The only call in the product that opens a wallet popup,
 * and it asks for identity, not permission to spend.
 */
export async function connect(provider: Eip1193Provider): Promise<`0x${string}`> {
  try {
    const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
    const first = accounts?.[0];
    if (!first) throw new WalletError("REJECTED", "wallet returned no accounts");
    return first.toLowerCase() as `0x${string}`;
  } catch (e) {
    if (isRejection(e)) throw new WalletError("REJECTED", "connection rejected in the wallet");
    throw new WalletError("RPC", e instanceof Error ? e.message : String(e));
  }
}

/** Accounts already authorised, without prompting. Used to restore a session silently. */
export async function silentAccounts(provider: Eip1193Provider): Promise<`0x${string}` | null> {
  try {
    const accounts = (await provider.request({ method: "eth_accounts" })) as string[];
    return (accounts?.[0]?.toLowerCase() as `0x${string}`) ?? null;
  } catch {
    return null;
  }
}

export async function chainId(provider: Eip1193Provider): Promise<number> {
  const raw = (await provider.request({ method: "eth_chainId" })) as string;
  return Number.parseInt(raw, 16);
}

/**
 * Ask the wallet to move to a Somnia chain, adding it if unknown.
 *
 * 4902 means the chain is not in the wallet yet; the recovery is to add it and
 * let the wallet switch as part of that, so a first-time user needs one approval
 * rather than an error telling them to go and configure a network by hand.
 */
export async function switchNetwork(provider: Eip1193Provider, net: Network): Promise<void> {
  const v = VENUE[net];
  const hex = `0x${v.chainId.toString(16)}`;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (e) {
    const code = (e as { code?: number }).code;
    if (code === 4902 || code === -32603) {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: hex,
            chainName: v.chainName,
            nativeCurrency: { name: gasTokenName(net), symbol: gasTokenName(net), decimals: 18 },
            rpcUrls: [v.rpc],
            blockExplorerUrls: [v.explorer],
          },
        ],
      });
      return;
    }
    if (isRejection(e)) throw new WalletError("REJECTED", "network switch rejected in the wallet");
    throw new WalletError("RPC", e instanceof Error ? e.message : String(e));
  }
}

// --- read-only chain access ------------------------------------------------
//
// Balances are read over plain JSON-RPC rather than through the wallet, so they
// stay correct when the wallet is on the wrong chain — which is exactly when the
// user most needs to be told what they actually hold and where.

let rpcId = 0;

async function rpc<T>(net: Network, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(VENUE[net].rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    // Bounded, for the same reason every read in this project is: a balance that
    // never arrives must become an error the UI can show, not a spinner forever.
    signal: timeoutSignal(15_000),
  });
  if (!res.ok) throw new WalletError("RPC", `${method} → HTTP ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new WalletError("RPC", `${method}: ${body.error.message}`);
  return body.result as T;
}

/** `balanceOf(address)` — the 4-byte selector, then the address left-padded to 32 bytes. */
const BALANCE_OF = "0x70a08231";
const encodeAddress = (a: string): string => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");

/** Big-endian hex to a whole-unit number, via BigInt so 18 decimals cannot lose the integer part. */
export function fromUnits(hex: string, decimals: number): number {
  const v = BigInt(hex === "0x" || !hex ? "0x0" : hex);
  const scale = 10n ** BigInt(decimals);
  // Split before converting: Number(10n ** 18n) is already past safe integers,
  // so dividing in BigInt first keeps the whole part exact and only the
  // fractional remainder goes through floating point.
  return Number(v / scale) + Number(v % scale) / Number(scale);
}

export async function nativeBalance(net: Network, address: string): Promise<number> {
  return fromUnits(await rpc<string>(net, "eth_getBalance", [address, "latest"]), 18);
}

export async function collateralBalance(net: Network, address: string): Promise<number> {
  const data = BALANCE_OF + encodeAddress(address);
  const hex = await rpc<string>(net, "eth_call", [{ to: COLLATERAL_TOKEN[net], data }, "latest"]);
  return fromUnits(hex, VENUE[net].decimals);
}

/** Everything the portfolio header shows, in one pass. */
export async function readWallet(provider: Eip1193Provider, address: `0x${string}`): Promise<WalletState> {
  const id = await chainId(provider);
  const net = networkOf(id);
  // With the wallet on an unrelated chain there is no Somnia balance to read and
  // reporting zero would be a lie; the UI shows the network error instead.
  if (net === null) {
    return {
      address, chainId: id, network: null, gas: 0, collateral: 0,
      gasSymbol: "", collateralSymbol: "",
    };
  }
  const [gas, collateral] = await Promise.all([nativeBalance(net, address), collateralBalance(net, address)]);
  return {
    address,
    chainId: id,
    network: net,
    gas,
    collateral,
    gasSymbol: gasTokenName(net),
    collateralSymbol: collateralName(net),
  };
}
