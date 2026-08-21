// Which key signs, and what it is allowed to say about itself.
//
// Two properties matter enough to pin, and they fail in opposite directions.
//
// The first is a safety default: when an agent wallet exists it must win over
// the raw key in `.env`, because the whole point of generating one is that the
// safer authority is also the automatic one. A regression here is silent — the
// bot keeps trading, just with the wallet that holds everything instead of the
// wallet that holds a float.
//
// The second is a disclosure rule: nothing in `describe()` may carry key
// material. That object is built for display and travels to a browser through
// the status endpoint, so a field added carelessly is a private key on a web
// page. The test greps the serialised form rather than checking named fields,
// so it also catches a key smuggled into a message string.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentWalletAuthority, EnvKeyAuthority, SessionKeyAuthority, authority, authorityStatus } from "./signer.js";

const OWNER_KEY = "0x" + "11".repeat(32);
const AGENT_KEY = "0x" + "22".repeat(32);

let dir: string;
const saved = {
  key: process.env.PRIVATE_KEY,
  file: process.env.RIVO_AGENT_KEY_FILE,
  prefer: process.env.RIVO_AUTHORITY,
  envFile: process.env.RIVO_ENV_FILE,
};

/** Point the agent authority at a temp file, with or without a key in it. */
function withAgentKey(key: string | null): string {
  const path = join(dir, "agent.key");
  if (key === null) {
    process.env.RIVO_AGENT_KEY_FILE = join(dir, "absent.key");
    return path;
  }
  writeFileSync(path, key + "\n");
  process.env.RIVO_AGENT_KEY_FILE = path;
  return path;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rivo-signer-"));
  delete process.env.RIVO_AUTHORITY;
  delete process.env.PRIVATE_KEY;
  // `EnvKeyAuthority` calls loadEnv(), which would read the developer's real
  // .env and hand these tests a live PRIVATE_KEY. Pointing it at a file that
  // does not exist makes "no key configured" mean exactly that, on a laptop
  // with a funded wallet and in CI alike.
  process.env.RIVO_ENV_FILE = join(dir, "no-such.env");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of [
    ["PRIVATE_KEY", saved.key],
    ["RIVO_AGENT_KEY_FILE", saved.file],
    ["RIVO_AUTHORITY", saved.prefer],
    ["RIVO_ENV_FILE", saved.envFile],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("agent wallet", () => {
  it("is unavailable when there is no key file", () => {
    withAgentKey(null);
    expect(new AgentWalletAuthority().available()).toBe(false);
  });

  it("is unavailable when the file holds something that is not a 32-byte key", () => {
    withAgentKey("0xdeadbeef");
    expect(new AgentWalletAuthority().available()).toBe(false);
  });

  it("tolerates the trailing newline every editor adds", () => {
    withAgentKey(AGENT_KEY);
    expect(new AgentWalletAuthority().available()).toBe(true);
  });

  it("adopts the key as the process signer only when asked", () => {
    withAgentKey(AGENT_KEY);
    process.env.PRIVATE_KEY = OWNER_KEY;
    const a = new AgentWalletAuthority();

    // describe() must never move the key — a status request cannot be allowed to
    // change what the process would sign with.
    a.describe();
    expect(process.env.PRIVATE_KEY).toBe(OWNER_KEY);

    expect(a.activate()).toBe(true);
    expect(process.env.PRIVATE_KEY).toBe(AGENT_KEY);
  });

  it("refuses to activate a key it would not sign with", () => {
    withAgentKey("nonsense");
    process.env.PRIVATE_KEY = OWNER_KEY;
    expect(new AgentWalletAuthority().activate()).toBe(false);
    expect(process.env.PRIVATE_KEY).toBe(OWNER_KEY);
  });
});

describe("which authority wins", () => {
  it("prefers the agent wallet over a raw key in .env", () => {
    withAgentKey(AGENT_KEY);
    process.env.PRIVATE_KEY = OWNER_KEY;
    expect(authority().kind).toBe("agent-wallet");
  });

  it("falls back to the raw key when no agent wallet exists", () => {
    withAgentKey(null);
    process.env.PRIVATE_KEY = OWNER_KEY;
    expect(authority().kind).toBe("raw-key");
  });

  it("honours RIVO_AUTHORITY=env for someone who means to trade their own wallet", () => {
    withAgentKey(AGENT_KEY);
    process.env.PRIVATE_KEY = OWNER_KEY;
    process.env.RIVO_AUTHORITY = "env";
    expect(authority().kind).toBe("raw-key");
  });

  it("reports no authority at all rather than pretending, when nothing is configured", () => {
    withAgentKey(null);
    expect(authority().available()).toBe(false);
    expect(new EnvKeyAuthority().describe().kind).toBe("none");
  });
});

describe("what the product may say", () => {
  it("never lets key material into the display object", async () => {
    withAgentKey(AGENT_KEY);
    process.env.PRIVATE_KEY = OWNER_KEY;
    const shown = JSON.stringify(await authorityStatus());
    expect(shown).not.toContain(AGENT_KEY);
    expect(shown).not.toContain(OWNER_KEY);
    expect(shown).not.toContain(AGENT_KEY.slice(2));
    expect(shown).not.toContain(OWNER_KEY.slice(2));
  });

  it("resolves the agent's own address, not the owner's", async () => {
    withAgentKey(AGENT_KEY);
    process.env.PRIVATE_KEY = OWNER_KEY;
    const { privateKeyToAccount } = await import("viem/accounts");
    const expected = privateKeyToAccount(AGENT_KEY as `0x${string}`).address.toLowerCase();
    expect((await authorityStatus()).address).toBe(expected);
  });

  it("does not claim an on-chain bound it does not have", () => {
    withAgentKey(AGENT_KEY);
    const d = new AgentWalletAuthority().describe();
    // The float is a real bound, but the chain is not the thing enforcing it.
    // Claiming otherwise is the exact overstatement this module exists to stop.
    expect(d.boundedOnChain).toBe(false);
    expect(d.bounds).toMatch(/float|balance/i);
  });

  it("explains the session-key gap with the measurement rather than an assertion", () => {
    const d = new SessionKeyAuthority().describe();
    expect(d.missing).toContain("0x3fb0ba2e");
    expect(d.missing).toContain("probe:operator");
  });
});
