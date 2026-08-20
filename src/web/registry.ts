// Many portfolios, one process.
//
// Rivo is meant to be a platform, so the backend holds a POLICY PER WALLET, each
// with its own state directory and its own runtime. Nothing is global: two users
// on one server have separate positions, separate cash and separate history, and
// neither can see or disturb the other's. That is the property that makes "one
// 24/7 Rivo backend" a coherent idea rather than a promise nobody could keep.
//
// It is deliberately not multi-tenant infrastructure. There is no database, no
// auth service and no queue, because none of those are what makes the isolation
// real — a directory per owner and a process per owner is. The pieces that would
// change under real load (storage, scheduling) are behind this module's surface.
//
// THE HONEST LIMIT, enforced here rather than described in a footnote:
//
//   The backend holds ONE signing key. So Autopilot — real orders, real money —
//   is permitted only for the wallet that IS that key's address. Any other
//   wallet gets Shadow Mode, because the alternative is trading one person's
//   capital from another person's key, which no amount of UI disclosure makes
//   acceptable. When ec-core grows a session-key or operator path (see
//   runtime/signer.ts) this restriction is what lifts, and it lifts here.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { newPolicy, parsePolicy, type PortfolioPolicy, type RunState } from "../portfolio/policy.js";
import { authorityStatus } from "../runtime/signer.js";
import { readState, runtimeStatus } from "./data.js";

export interface RegistryOptions {
  /** Root data directory. Each portfolio gets `<root>/portfolios/<owner>`. */
  dataDir: string;
  repoRoot: string;
  intervalMs: number;
}

export interface PortfolioRecord {
  policy: PortfolioPolicy;
  /** Where this portfolio's state.json and decision log live. */
  dataDir: string;
  /** Whether a runtime this process started is alive for this owner. */
  running: boolean;
  pid?: number;
}

const isAddress = (s: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(s);

export class PortfolioRegistry {
  private readonly children = new Map<string, ChildProcess>();
  /** Cached signer address, resolved once — it cannot change while we run. */
  private signerAddress: string | null | undefined;

  constructor(private readonly opts: RegistryOptions) {
    mkdirSync(this.root, { recursive: true });
  }

  private get root(): string {
    return join(this.opts.dataDir, "portfolios");
  }

  /** Per-owner directory. The owner segment is validated, so it cannot traverse. */
  dirFor(owner: string): string {
    const o = owner.toLowerCase();
    if (!isAddress(o)) throw new Error("owner must be a wallet address");
    return join(this.root, o);
  }

  private fileFor(owner: string): string {
    return join(this.dirFor(owner), "policy.json");
  }

  /** The address Autopilot is permitted for, or null when no key is configured. */
  async signer(): Promise<string | null> {
    if (this.signerAddress === undefined) {
      const a = await authorityStatus();
      this.signerAddress = a.address ? a.address.toLowerCase() : null;
    }
    return this.signerAddress;
  }

  /**
   * Whether this owner may run Autopilot, and why not when they may not.
   *
   * Returns the reason rather than a boolean so the UI never has to invent an
   * explanation for a refusal it did not make.
   */
  async autopilotRefusal(owner: string): Promise<string | null> {
    const signer = await this.signer();
    if (!signer) return "This backend holds no signing key, so it can only run Shadow Mode.";
    if (signer !== owner.toLowerCase()) {
      return (
        `Autopilot is restricted to the wallet this backend signs as (${signer.slice(0, 6)}…${signer.slice(-4)}). ` +
        `Running it for another wallet would place orders from a key that is not yours and settle into an account that is not yours. ` +
        `Shadow Mode is available to every wallet.`
      );
    }
    return null;
  }

  get(owner: string): PortfolioRecord | null {
    const file = this.fileFor(owner);
    if (!existsSync(file)) return null;
    try {
      const policy = parsePolicy(JSON.parse(readFileSync(file, "utf8")));
      return this.decorate(policy);
    } catch {
      return null;
    }
  }

  list(): PortfolioRecord[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root)
      .filter(isAddress)
      .map((o) => this.get(o))
      .filter((r): r is PortfolioRecord => r !== null);
  }

  /** Create or replace an owner's policy. Autopilot is downgraded when refused. */
  async put(input: unknown): Promise<PortfolioRecord> {
    const policy = parsePolicy(input);
    if (policy.mode === "autopilot") {
      const refusal = await this.autopilotRefusal(policy.owner);
      if (refusal) {
        policy.mode = "shadow";
        policy.stoppedReason = refusal;
      }
    }
    const dir = this.dirFor(policy.owner);
    mkdirSync(dir, { recursive: true });
    writeFileSync(this.fileFor(policy.owner), JSON.stringify(policy, null, 2));
    return this.decorate(policy);
  }

  /** Move a portfolio between lifecycle states, starting or stopping its runtime. */
  async command(owner: string, action: "start" | "pause" | "stop"): Promise<PortfolioRecord> {
    const existing = this.get(owner);
    const policy = existing?.policy ?? newPolicy(owner, 50, "balanced");
    const next: RunState = action === "start" ? "running" : action === "pause" ? "paused" : "stopped";

    if (action === "start") {
      const refusal = policy.mode === "autopilot" ? await this.autopilotRefusal(owner) : null;
      if (refusal) {
        // Refuse loudly rather than quietly downgrading a running portfolio: the
        // user asked for live orders and must be told they are not getting them.
        throw new Error(refusal);
      }
      this.spawnRuntime(policy);
    } else {
      this.stopRuntime(owner);
    }
    return this.put({ ...policy, state: next, updatedAt: Math.floor(Date.now() / 1000) });
  }

  private decorate(policy: PortfolioPolicy): PortfolioRecord {
    const child = this.children.get(policy.owner);
    const alive = Boolean(child && child.exitCode === null && !child.killed);
    return {
      policy,
      dataDir: this.dirFor(policy.owner),
      running: alive,
      ...(alive && child?.pid ? { pid: child.pid } : {}),
    };
  }

  /**
   * Start a runtime for this owner, in its own data directory.
   *
   * Refuses when one is already writing that directory — including one this
   * process did not start. Two writers on one state file do not merge; each
   * overwrites the other and the portfolio becomes fiction.
   */
  private spawnRuntime(policy: PortfolioPolicy): void {
    const owner = policy.owner;
    const dir = this.dirFor(owner);
    mkdirSync(dir, { recursive: true });

    const existing = this.children.get(owner);
    if (existing && existing.exitCode === null && !existing.killed) return;

    const status = runtimeStatus(readState(dir), false);
    if (status.running) {
      throw new Error(
        `a runtime is already writing ${dir} (last cycle ${status.sinceLastCycleSec}s ago). Stop it before starting another.`,
      );
    }

    const args = [
      "src/cli/run.ts",
      "--capital", String(policy.capital),
      "--profile", policy.profile,
      "--interval-ms", String(this.opts.intervalMs),
      "--data-dir", dir,
    ];
    if (policy.mode === "autopilot") args.push("--live");

    // Its own process group, so stopping reaches the grandchild that actually
    // holds the positions rather than the npx wrapper in front of it.
    const child = spawn("npx", ["tsx", ...args], {
      cwd: this.opts.repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const tag = `[${owner.slice(0, 6)}…${owner.slice(-4)}]`;
    child.stdout?.on("data", (b: Buffer) => process.stdout.write(`${tag} ${b.toString()}`));
    child.stderr?.on("data", (b: Buffer) => process.stderr.write(`${tag} ${b.toString()}`));
    child.on("exit", (code) => {
      console.log(`${tag} runtime exited with code ${code}`);
      this.children.delete(owner);
    });
    this.children.set(owner, child);
  }

  private stopRuntime(owner: string): void {
    const child = this.children.get(owner);
    const pid = child?.pid;
    if (!pid) return;
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        child?.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
  }

  /** Stop every runtime this process started. Called on shutdown. */
  stopAll(): void {
    for (const owner of this.children.keys()) this.stopRuntime(owner);
  }
}
