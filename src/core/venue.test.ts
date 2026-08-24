// One table, and nothing allowed to hold a second copy of what is in it.
//
// The RPC host was written out in six places — three in the runtime, three in
// scripts — and the chain id in four, while `VENUE` sat here holding both. One
// of those call sites (scripts/doctor.ts) read the registry on the line above
// and then ignored it, which is what a copied ternary looks like after a few
// months: nobody chose it, it was pasted.
//
// Nothing about that was broken. The failure arrives later and quietly: Somnia
// moves an endpoint, the table is corrected, and five call sites keep the old
// host with no test red and no type error to say so. Correctness that depends
// on somebody grepping is not correctness.
//
// So the rule is mechanical. The literals live here; anywhere else is a copy.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { chainIdOf, gasTokenName, networkOfChainId, NETWORKS, rpcUrl, VENUE } from "./venue.js";

/**
 * Every tracked TypeScript source, which is narrower and faster than a walk.
 *
 * `git ls-files` lists what the index tracks, which includes files deleted from
 * the working tree but not yet staged. Reading one of those throws ENOENT and
 * fails a rule about hardcoded hostnames with a message about a missing file —
 * so the existence check is part of the query, not an afterthought. This broke
 * exactly once, mid-deletion, and cost more time to read than to fix.
 */
const sources = (): string[] =>
  execFileSync("git", ["ls-files", "*.ts", "*.tsx"], { encoding: "utf8" })
    .split("\n")
    .filter((f) => f && !f.startsWith("web/.next/") && existsSync(resolve(f)));

/** Source with comments removed — the rule is about code, not about the note explaining it. */
const code = (f: string): string =>
  readFileSync(resolve(f), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("the venue table is the only copy", () => {
  it("holds the only RPC hostnames", () => {
    const offenders = sources().filter(
      (f) => f !== "src/core/venue.ts" && /api\.infra\.(testnet|mainnet)\.somnia\.network/.test(code(f)),
    );
    expect(offenders, "these spell out an RPC host that VENUE already holds").toEqual([]);
  });

  it("holds the only chain ids", () => {
    // Bare 5031 / 50312 anywhere else is either a second copy or a coincidence
    // worth renaming. `.env.example` and docs are excluded: those are for humans
    // to read, and a config example that says `NETWORK=` and nothing else helps
    // nobody.
    const offenders = sources().filter(
      (f) => f !== "src/core/venue.ts" && !f.endsWith(".test.ts") && /\b(5031|50312)\b/.test(code(f)),
    );
    expect(offenders, "these hardcode a chain id that chainIdOf() returns").toEqual([]);
  });

  it("holds the only collateral names", () => {
    const offenders = sources().filter(
      (f) => f !== "src/core/venue.ts" && !f.endsWith(".test.ts") && /"(tUSDC|USDso)"/.test(code(f)),
    );
    expect(offenders, "these name a collateral token that collateralName() returns").toEqual([]);
  });

  it("holds the only gas-token names", () => {
    const offenders = sources().filter(
      (f) => f !== "src/core/venue.ts" && !f.endsWith(".test.ts") && /"(SOMI|STT)"/.test(code(f)),
    );
    expect(offenders, "these name a gas token that gasTokenName() returns").toEqual([]);
  });
});

describe("the resolvers", () => {
  it("returns the table's RPC when nothing overrides it", () => {
    for (const n of NETWORKS) expect(rpcUrl(n)).toBe(VENUE[n].rpc);
  });

  it("prefers an override, and ignores an empty or blank one", () => {
    // The call sites pass `process.env.RPC_URL` straight through, and an unset
    // variable in a .env file arrives as "" rather than undefined — which would
    // otherwise resolve to an empty RPC URL and fail at connect time with a
    // message about the URL rather than about the configuration.
    expect(rpcUrl("testnet", "https://rpc.example/1")).toBe("https://rpc.example/1");
    expect(rpcUrl("testnet", "")).toBe(VENUE.testnet.rpc);
    expect(rpcUrl("testnet", "   ")).toBe(VENUE.testnet.rpc);
    expect(rpcUrl("testnet", null)).toBe(VENUE.testnet.rpc);
    expect(rpcUrl("testnet", undefined)).toBe(VENUE.testnet.rpc);
  });

  it("round-trips a chain id back to its network", () => {
    for (const n of NETWORKS) expect(networkOfChainId(chainIdOf(n))).toBe(n);
  });

  it("answers testnet for an unknown chain, which is the safe direction", () => {
    // Being wrong toward the testnet label is cosmetic. Being wrong toward
    // mainnet reads as a claim about real money.
    expect(networkOfChainId(1)).toBe("testnet");
    expect(networkOfChainId(0)).toBe("testnet");
    expect(gasTokenName(networkOfChainId(1))).toBe("STT");
  });

  it("gives the two networks different chain ids", () => {
    // Guards the copy-paste that would make networkOfChainId ambiguous.
    expect(chainIdOf("testnet")).not.toBe(chainIdOf("mainnet"));
  });
});
