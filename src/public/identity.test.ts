// Who the portfolio belongs to, and how you leave.
//
// Three states share one header widget, and each has exactly one correct set of
// controls. They went untested for a while and drifted apart: the demo identity
// — added so that nobody has to install a browser extension to try the product —
// shipped with no way out at all. You could enter it and never return to the
// gate, because the only exit offered was to connect the very wallet the demo
// existed to avoid.
//
// The other half is continuity. Every stored value is namespaced by owner, so
// connecting a wallet moves you to a different namespace; without an explicit
// hand-off, the portfolio someone spent ten minutes configuring appears to
// vanish. The gate promises it does not, so the promise is pinned here.

import { beforeEach, describe, expect, it } from "vitest";
import * as store from "./store.js";
import { walletChip, type AppState } from "./ui/portfolio.js";
import type { WalletState } from "./wallet.js";
import { newPolicy } from "../portfolio/policy.js";
import { emptyPortfolio } from "./engine.js";

const WALLET = "0x1111111111111111111111111111111111111111";

/** localStorage, minimally, since these tests run in Node. */
function fakeStorage(): void {
  const map = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
}

const wallet = (address: string, over: Partial<WalletState> = {}): WalletState => ({
  address: address as `0x${string}`,
  chainId: 50312,
  network: "testnet",
  gas: 1,
  collateral: 25,
  gasSymbol: "STT",
  collateralSymbol: "tUSDC",
  ...over,
});

const stateWith = (w: WalletState | null): AppState =>
  ({
    wallet: w,
    connecting: false,
    error: null,
    policy: null,
    view: null,
    backend: null,
    draft: { capital: 50, profile: "balanced", mode: "shadow" },
    busy: false,
    showAdvanced: false,
    equity: [],
    activity: [],
  }) as AppState;

beforeEach(() => {
  fakeStorage();
});

describe("the header offers a way out of every state", () => {
  it("offers a way in when nobody is connected", () => {
    const html = walletChip(stateWith(null));
    expect(html).toContain('data-act="connect"');
  });

  it("lets a real wallet disconnect", () => {
    const html = walletChip(stateWith(wallet(WALLET)));
    expect(html).toContain('data-act="disconnect"');
    expect(html).toContain("Forget this wallet");
  });

  it("lets a demo portfolio be discarded, not only replaced by a wallet", () => {
    const demo = store.demoIdentity();
    const html = walletChip(stateWith(wallet(demo)));
    expect(html).toContain('data-act="disconnect"');
    // Still offers the upgrade path — discarding is an addition, not a swap.
    expect(html).toContain('data-act="connect"');
    // And says what it really does: nothing is connected, so nothing disconnects.
    expect(html).toContain("Discard");
  });

  it("says the network is wrong before it says anything else", () => {
    const html = walletChip(stateWith(wallet(WALLET, { network: null })));
    expect(html).toContain("wrong network");
    expect(html).toContain('data-act="switch"');
  });
});

describe("the demo identity", () => {
  it("is stable across calls, so a reload finds the same portfolio", () => {
    expect(store.demoIdentity()).toBe(store.demoIdentity());
  });

  it("is shaped like an address and marked as a demo", () => {
    const id = store.demoIdentity();
    expect(id).toMatch(/^0xde[0-9a-f]{38}$/);
    expect(store.isDemo(id)).toBe(true);
    expect(store.isDemo(WALLET)).toBe(false);
  });

  it("is genuinely new after a discard, rather than the old one resurrected", () => {
    const first = store.demoIdentity();
    store.savePolicy(newPolicy(first, 50, "balanced"));
    store.forgetIdentity(first);
    expect(store.loadPolicy(first)).toBeNull();
    expect(store.demoIdentity()).not.toBe(first);
  });
});

describe("connecting a wallet keeps what the demo built", () => {
  it("moves the policy, portfolio and activity onto the wallet", () => {
    const demo = store.demoIdentity();
    const policy = store.configure(demo, { capital: 77, profile: "active", mode: "shadow" });
    store.savePortfolio(emptyPortfolio(policy));
    store.appendActivity(demo, [{ at: 1, kind: "note", text: "hello" }]);

    expect(store.adoptInto(demo, WALLET)).toBe(true);

    const moved = store.loadPolicy(WALLET);
    expect(moved?.capital).toBe(77);
    expect(moved?.profile).toBe("active");
    // The owner travels with it, or every later save writes to the old namespace.
    expect(moved?.owner).toBe(WALLET.toLowerCase());
    expect(store.loadPortfolio(WALLET, moved!).owner).toBe(WALLET.toLowerCase());
    expect(store.loadActivity(WALLET)).toHaveLength(1);
    // And the demo is gone rather than left as a duplicate to diverge from.
    expect(store.loadPolicy(demo)).toBeNull();
  });

  it("refuses to overwrite a wallet that already has a portfolio", () => {
    const demo = store.demoIdentity();
    store.configure(demo, { capital: 10, profile: "conservative", mode: "shadow" });
    store.configure(WALLET, { capital: 500, profile: "balanced", mode: "shadow" });

    expect(store.adoptInto(demo, WALLET)).toBe(false);
    expect(store.loadPolicy(WALLET)?.capital).toBe(500);
    // The demo survives the refusal — losing it here would be the worst of both.
    expect(store.loadPolicy(demo)?.capital).toBe(10);
  });

  it("does nothing when there is no demo policy to move", () => {
    expect(store.adoptInto(store.demoIdentity(), WALLET)).toBe(false);
  });
});
