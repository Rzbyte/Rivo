// ERC-20 approval for the pool that escrows collateral.
//
// THIS MODULE IS BELT AND BRACES, AND THE COMMENT THAT USED TO BE HERE WAS WRONG.
//
// It said `@somnia-chain/markets-sdk` has no approval handling, so a fresh
// wallet's first Event Contract order always reverts. That is false, and it was
// false when it was written. `orders.js::placeOrder` — the binary path — opens
// with an `autoApprove` block that calls `approveIfNeeded(escrow.token, pool,
// amount, gas)` for a buy and `ensureOperator` for a sell. `ec-core` never
// passes `autoApprove`, so it is on. Measured end to end on 2026-09-05: a wallet
// holding zero allowance to the pool, one `ec-core.placeLimit`, and the
// allowance afterwards is `maxUint256` to the pool — granted by the SDK, with no
// allowance code of ours involved.
//
// The evidence that convinced us otherwise was a working wallet holding an
// unlimited allowance to the POOL specifically. That was the SDK doing its job,
// and we read it as the SDK failing. The reverts we were actually chasing were
// the venue's lot constraint (SDK-FEEDBACK #5).
//
// So why keep it? Because approving is idempotent and cheap, and because the
// gate it guards is not the SDK's behaviour but ours: Rivo's per-user wallets
// sign through a TEE, and an explicit, auditable approval we issue ourselves is
// a thing the ledger can point at. It runs before the SDK would, finds the
// allowance already sufficient on the second and every later order, and costs
// one cached read.
//
// Pools are recycled across successive windows rather than deployed per window,
// so the set of addresses needing approval is small and stable. One approval per
// pool, cached, is enough.

import { createPublicClient, createWalletClient, defineChain, http, maxUint256, type Account, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { gasTokenName, networkOfChainId } from "../core/venue.js";

const ERC20 = [
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

export interface AllowanceConfig {
  rpcUrl: string;
  chainId: number;
  token: Address;
  /**
   * The key to sign with, when Rivo holds one.
   *
   * Exactly one of `privateKey` and `account` is required. The split exists
   * because approval is a chain write like any other, and the whole point of the
   * Privy authority is that Rivo never holds key material — so this had to stop
   * being a key-shaped hole. A viem `Account` covers both: a local key produces
   * one, and so does a wallet whose signing happens inside somebody else's
   * enclave.
   */
  privateKey?: string;
  /** A pre-built signer. Anything with `signTransaction` — see src/signing/privy.ts. */
  account?: Account;
}

export class AllowanceManager {
  /** Pools already known to be approved this process. */
  private readonly approved = new Set<string>();
  private readonly account;
  private readonly pub;
  private readonly wallet;
  private readonly token: Address;

  constructor(cfg: AllowanceConfig) {
    this.token = cfg.token;
    if (!cfg.account && !cfg.privateKey) {
      throw new Error("AllowanceManager needs either an account or a private key to sign an approval");
    }
    this.account = cfg.account ?? privateKeyToAccount(cfg.privateKey as `0x${string}`);
    const chain = defineChain({
      id: cfg.chainId,
      name: `somnia-${cfg.chainId}`,
      // A third copy of the gas-token rule lived here as `chainId === 5031`.
      // venue.ts already owns it.
      nativeCurrency: { name: "Somnia", symbol: gasTokenName(networkOfChainId(cfg.chainId)), decimals: 18 },
      rpcUrls: { default: { http: [cfg.rpcUrl] } },
    });
    this.pub = createPublicClient({ chain, transport: http(cfg.rpcUrl) });
    this.wallet = createWalletClient({ account: this.account, chain, transport: http(cfg.rpcUrl) });
  }

  get address(): Address {
    return this.account.address;
  }

  async allowanceFor(pool: Address): Promise<bigint> {
    return this.pub.readContract({
      address: this.token,
      abi: ERC20,
      functionName: "allowance",
      args: [this.account.address, pool],
    });
  }

  /**
   * Make sure `pool` can pull at least `need` collateral, approving if not.
   *
   * Approves the maximum rather than a multiple of the requirement. The kit's
   * spot path approves `amount * 8`, which is right when there is one long-lived
   * pool per pair; here a recycled pool sees an unbounded stream of windows, and
   * re-approving mid-series costs a transaction and a round trip at exactly the
   * moment an edge is disappearing. The venue's own active wallets hold
   * unlimited approvals for the same reason.
   *
   * Returns the transaction hash when it approved, or null when nothing was needed.
   */
  async ensure(pool: Address, need: bigint): Promise<string | null> {
    const key = pool.toLowerCase();
    if (this.approved.has(key)) return null;
    const current = await this.allowanceFor(pool);
    if (current >= need && current > 0n) {
      this.approved.add(key);
      return null;
    }
    const hash = await this.wallet.writeContract({
      address: this.token,
      abi: ERC20,
      functionName: "approve",
      args: [pool, maxUint256],
    });
    await this.pub.waitForTransactionReceipt({ hash });
    this.approved.add(key);
    return hash;
  }

  /** Forget a cached approval, so the next order re-checks it on-chain. */
  forget(pool: Address): void {
    this.approved.delete(pool.toLowerCase());
  }
}
