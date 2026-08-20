// The wallet module is the one place a browser bug becomes a money bug, so what
// is pinned here is the arithmetic and the refusal to guess: unit conversion at
// 18 decimals, and reporting nothing rather than zero when the chain is wrong.

import { describe, expect, it, vi } from "vitest";
import { connect, fromUnits, networkOf, silentAccounts, WalletError, type Eip1193Provider } from "./wallet.js";
import { VENUE } from "../core/venue.js";

const provider = (impl: (m: string) => unknown): Eip1193Provider => ({
  request: async ({ method }) => {
    const r = impl(method);
    if (r instanceof Error) throw r;
    return r;
  },
});

describe("fromUnits", () => {
  it("keeps the whole part exact at 18 decimals", () => {
    // 1234567.891 STT is already past Number.MAX_SAFE_INTEGER in raw units, so a
    // naive Number(hex)/1e18 loses the integer part — the balance a user reads.
    const raw = 1234567891000000000000000n;
    expect(fromUnits(`0x${raw.toString(16)}`, 18)).toBeCloseTo(1234567.891, 6);
  });

  it("handles 6-decimal collateral", () => {
    expect(fromUnits("0x" + (50_000_000n).toString(16), 6)).toBe(50);
  });

  it("treats an empty result as zero rather than throwing", () => {
    expect(fromUnits("0x", 18)).toBe(0);
    expect(fromUnits("", 6)).toBe(0);
  });
});

describe("networkOf", () => {
  it("maps Somnia chain ids and rejects everything else", () => {
    expect(networkOf(VENUE.testnet.chainId)).toBe("testnet");
    expect(networkOf(VENUE.mainnet.chainId)).toBe("mainnet");
    expect(networkOf(1)).toBeNull();
  });
});

describe("connect", () => {
  it("lowercases the returned account", async () => {
    const p = provider(() => ["0xABCDEF0123456789ABCDEF0123456789ABCDEF01"]);
    expect(await connect(p)).toBe("0xabcdef0123456789abcdef0123456789abcdef01");
  });

  it("reports a user rejection as REJECTED, not as an RPC failure", async () => {
    const rejection = Object.assign(new Error("User rejected"), { code: 4001 });
    const p = provider(() => rejection);
    await expect(connect(p)).rejects.toMatchObject({ code: "REJECTED" });
  });

  it("throws rather than returning undefined when the wallet returns no accounts", async () => {
    await expect(connect(provider(() => []))).rejects.toBeInstanceOf(WalletError);
  });

  it("silentAccounts never throws — a failed restore must not break the page", async () => {
    expect(await silentAccounts(provider(() => new Error("locked")))).toBeNull();
  });
});

describe("the module cannot sign", () => {
  it("never issues a signing method", async () => {
    // A regression here would mean the read-only identity path had quietly become
    // a spending path. Assert on the actual method names the module sends.
    const seen: string[] = [];
    const p: Eip1193Provider = {
      request: async ({ method }) => {
        seen.push(method);
        if (method === "eth_requestAccounts") return ["0x1111111111111111111111111111111111111111"];
        if (method === "eth_chainId") return "0xc488";
        return null;
      },
    };
    await connect(p);
    await silentAccounts(p);
    const signing = seen.filter((m) => /sign|sendTransaction|personal_|eth_sendRaw/i.test(m));
    expect(signing).toEqual([]);
  });
});
