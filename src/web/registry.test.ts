// The registry is what makes "one backend, many users" true rather than claimed,
// so the properties pinned here are the isolation ones: a policy cannot escape
// its directory, one wallet cannot read or overwrite another's, and — the one
// that matters most — a wallet that is not the signer cannot get Autopilot.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PortfolioRegistry } from "./registry.js";

const A = "0xAAAA1111222233334444555566667777888899AA";
const B = "0xbbbb1111222233334444555566667777888899bb";

let dir: string;
let registry: PortfolioRegistry;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rivo-registry-"));
  registry = new PortfolioRegistry({ dataDir: dir, repoRoot: process.cwd(), intervalMs: 60_000 });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("isolation", () => {
  it("gives each wallet its own directory, keyed by the lowercased address", async () => {
    await registry.put({ owner: A, capital: 10, profile: "conservative" });
    await registry.put({ owner: B, capital: 900, profile: "active" });
    expect(registry.dirFor(A)).toContain(A.toLowerCase());
    expect(registry.dirFor(A)).not.toBe(registry.dirFor(B));
    expect(existsSync(join(registry.dirFor(A), "policy.json"))).toBe(true);
  });

  it("keeps one wallet's policy out of another's", async () => {
    await registry.put({ owner: A, capital: 10, profile: "conservative" });
    await registry.put({ owner: B, capital: 900, profile: "active" });
    expect(registry.get(A)!.policy.capital).toBe(10);
    expect(registry.get(A)!.policy.profile).toBe("conservative");
    expect(registry.get(B)!.policy.capital).toBe(900);
    expect(registry.get(B)!.policy.profile).toBe("active");
  });

  it("treats two spellings of one address as one portfolio", async () => {
    await registry.put({ owner: A, capital: 10, profile: "balanced" });
    await registry.put({ owner: A.toLowerCase(), capital: 11, profile: "balanced" });
    expect(registry.list()).toHaveLength(1);
    expect(registry.get(A)!.policy.capital).toBe(11);
  });

  it("refuses an owner that is not an address, so no path can traverse", () => {
    for (const bad of ["../../etc", "0x../..", "not-an-address", "0xZZZZ", ""]) {
      expect(() => registry.dirFor(bad)).toThrow(/wallet address/);
    }
  });

  it("returns null for a wallet with no portfolio rather than inventing one", () => {
    expect(registry.get(B)).toBeNull();
    expect(registry.list()).toEqual([]);
  });
});

describe("autopilot is restricted to the backend's own signer", () => {
  /** Force the resolved signer without touching the environment. */
  const withSigner = (r: PortfolioRegistry, address: string | null) => {
    (r as unknown as { signerAddress: string | null }).signerAddress = address;
    return r;
  };

  it("downgrades a foreign wallet to shadow, with the reason attached", async () => {
    withSigner(registry, B.toLowerCase());
    const rec = await registry.put({ owner: A, capital: 10, profile: "balanced", mode: "experimental_testnet" });
    expect(rec.policy.mode).toBe("shadow");
    expect(rec.policy.stoppedReason).toMatch(/restricted to the wallet this backend signs as/);
  });

  it("permits autopilot for the signer's own wallet", async () => {
    withSigner(registry, A.toLowerCase());
    const rec = await registry.put({ owner: A, capital: 10, profile: "balanced", mode: "experimental_testnet" });
    expect(rec.policy.mode).toBe("experimental_testnet");
    expect(rec.policy.stoppedReason).toBeUndefined();
  });

  it("refuses autopilot outright when the backend holds no key", async () => {
    withSigner(registry, null);
    const rec = await registry.put({ owner: A, capital: 10, profile: "balanced", mode: "experimental_testnet" });
    expect(rec.policy.mode).toBe("shadow");
    expect(rec.policy.stoppedReason).toMatch(/no signing key/);
  });

  it("never downgrades shadow, which every wallet may run", async () => {
    withSigner(registry, B.toLowerCase());
    const rec = await registry.put({ owner: A, capital: 10, profile: "active", mode: "shadow" });
    expect(rec.policy.mode).toBe("shadow");
    expect(rec.policy.stoppedReason).toBeUndefined();
  });

  it("throws rather than silently downgrading a START that asked for autopilot", async () => {
    // A quiet downgrade at start would leave the user believing real orders are
    // being placed. The refusal has to reach them.
    withSigner(registry, B.toLowerCase());
    await registry.put({ owner: A, capital: 10, profile: "balanced" });
    // Write an autopilot policy directly, bypassing put()'s downgrade, to model a
    // policy that became stale when the backend's key changed.
    const rec = registry.get(A)!;
    (rec.policy as { mode: string }).mode = "experimental_testnet";
    await registry.put({ ...rec.policy, mode: "shadow" });
    const refusal = await registry.autopilotRefusal(A);
    expect(refusal).toMatch(/restricted/);
  });
});

describe("validation", () => {
  it("rejects a malformed policy at the boundary", async () => {
    await expect(registry.put({ owner: A, capital: -1 })).rejects.toThrow(/capital/);
    await expect(registry.put({ owner: "nope", capital: 1 })).rejects.toThrow(/owner/);
  });

  it("pause and stop move state without needing a running runtime", async () => {
    await registry.put({ owner: A, capital: 10, profile: "balanced" });
    expect((await registry.command(A, "pause")).policy.state).toBe("paused");
    expect((await registry.command(A, "stop")).policy.state).toBe("stopped");
  });
});
