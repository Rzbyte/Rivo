// Per-wallet persistence for the browser.
//
// Keyed by wallet address, always. Two people using the same machine, or one
// person with a trading wallet and a spare, get separate portfolios with
// separate policies and separate history — the same isolation the backend gives
// two users, expressed in the only storage a static page has.
//
// The key shape is deliberate: `rivo:v1:<address>:<slot>`. The version lets a
// future schema change be detected rather than silently misread, and the address
// segment means enumerating one wallet's data cannot reach another's.
//
// Nothing sensitive is stored. A policy is a capital figure and a set of
// ceilings; the shadow portfolio is paper positions. There is no key here and no
// place one could be put, which is the point — see wallet.ts on why browser
// identity and signing authority are separate concerns.

import { newPolicy, parsePolicy, type PortfolioPolicy, type RunMode } from "../portfolio/policy.js";
import { emptyPortfolio, type Activity, type ShadowPortfolio } from "./engine.js";
import type { ProfileName } from "../portfolio/profiles.js";

const NS = "rivo:v1";
const key = (owner: string, slot: string) => `${NS}:${owner.toLowerCase()}:${slot}`;

/** Storage that degrades to memory when localStorage is unavailable (private mode, embedded views). */
interface Store {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

const memory = new Map<string, string>();
const memoryStore: Store = {
  getItem: (k) => memory.get(k) ?? null,
  setItem: (k, v) => void memory.set(k, v),
  removeItem: (k) => void memory.delete(k),
};

function store(): Store {
  try {
    const ls = globalThis.localStorage;
    if (!ls) return memoryStore;
    // Presence is not availability: Safari's private mode throws on write.
    const probe = `${NS}:probe`;
    ls.setItem(probe, "1");
    ls.removeItem(probe);
    return ls;
  } catch {
    return memoryStore;
  }
}

function read<T>(k: string): T | null {
  try {
    const raw = store().getItem(k);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    // Corrupt entry: treat as absent. Throwing here would brick the app for a
    // user whose only fix is clearing storage they cannot see.
    return null;
  }
}

function write(k: string, v: unknown): void {
  try {
    store().setItem(k, JSON.stringify(v));
  } catch {
    // Quota or private mode. Losing persistence is survivable; the session keeps
    // running from memory and the user is not interrupted over it.
  }
}

export function loadPolicy(owner: string): PortfolioPolicy | null {
  const raw = read<PortfolioPolicy>(key(owner, "policy"));
  if (!raw) return null;
  try {
    // Re-validate on read. Stored data is as untrusted as network data once a
    // schema has changed under it.
    const parsed = parsePolicy(raw);
    return parsed.owner === owner.toLowerCase() ? parsed : null;
  } catch {
    return null;
  }
}

export const savePolicy = (p: PortfolioPolicy): void => write(key(p.owner, "policy"), p);

export function loadPortfolio(owner: string, policy: PortfolioPolicy): ShadowPortfolio {
  const raw = read<ShadowPortfolio>(key(owner, "portfolio"));
  if (!raw || raw.owner !== owner.toLowerCase() || !Array.isArray(raw.open)) return emptyPortfolio(policy);
  return raw;
}

export const savePortfolio = (pf: ShadowPortfolio): void => write(key(pf.owner, "portfolio"), pf);

/** The rolling activity feed. Capped so a long-running tab cannot fill storage. */
const ACTIVITY_CAP = 300;

export function loadActivity(owner: string): Activity[] {
  return read<Activity[]>(key(owner, "activity")) ?? [];
}

export function appendActivity(owner: string, entries: Activity[]): Activity[] {
  if (entries.length === 0) return loadActivity(owner);
  const merged = [...entries, ...loadActivity(owner)].slice(0, ACTIVITY_CAP);
  write(key(owner, "activity"), merged);
  return merged;
}

/** Start a portfolio over, keeping the wallet. Used by the reset control. */
export function resetPortfolio(policy: PortfolioPolicy): ShadowPortfolio {
  const fresh = emptyPortfolio(policy);
  savePortfolio(fresh);
  write(key(policy.owner, "activity"), []);
  return fresh;
}

/** Create or update this wallet's policy from the configuration form. */
export function configure(
  owner: string,
  input: { capital: number; profile: ProfileName; mode: RunMode; overrides?: PortfolioPolicy["overrides"] },
): PortfolioPolicy {
  const existing = loadPolicy(owner);
  const base = existing ?? newPolicy(owner, input.capital, input.profile, input.mode);
  const next: PortfolioPolicy = {
    ...base,
    capital: input.capital,
    profile: input.profile,
    mode: input.mode,
    overrides: input.overrides ?? base.overrides,
    updatedAt: Math.floor(Date.now() / 1000),
  };
  savePolicy(next);
  return next;
}

/**
 * Move a demo portfolio onto a real wallet, once there is one.
 *
 * The gate promises that connecting later keeps what you built, and without
 * this it did not: every stored value is namespaced by owner, so connecting
 * switched to an empty namespace and the demo run appeared to evaporate. It was
 * still on disk under the demo id, and reachable only by disconnecting again —
 * a recovery nobody would guess at.
 *
 * Refuses to overwrite. A wallet that already has a policy has a history of its
 * own, and a demo portfolio is not worth clobbering it for; returns false so the
 * caller can leave both in place.
 */
export function adoptInto(from: string, to: string): boolean {
  if (from.toLowerCase() === to.toLowerCase()) return false;
  if (loadPolicy(to)) return false;
  const policy = loadPolicy(from);
  if (!policy) return false;

  const moved: PortfolioPolicy = { ...policy, owner: to.toLowerCase() };
  savePolicy(moved);
  const pf = loadPortfolio(from, policy);
  savePortfolio({ ...pf, owner: to.toLowerCase() });
  write(key(to, "activity"), loadActivity(from));
  forgetIdentity(from);
  return true;
}

/**
 * Erase an identity's stored portfolio, policy and activity.
 *
 * Only the demo path uses this, and the distinction is worth keeping sharp.
 * Disconnecting a real wallet must NOT delete anything: the person still owns
 * that address, will very likely reconnect, and would be startled to find their
 * policy gone. A demo identity has no such continuity — discarding it is the
 * only way to start over, so the data goes with it, including the identity
 * itself, so the next demo is genuinely new rather than the old one resurrected.
 */
export function forgetIdentity(owner: string): void {
  const s = store();
  for (const slot of ["policy", "portfolio", "activity"]) {
    try {
      s.removeItem(key(owner, slot));
    } catch {
      /* a storage that refuses to delete is one we cannot help */
    }
  }
  if (isDemo(owner)) {
    try {
      s.removeItem(`${NS}:demo`);
    } catch {
      /* as above */
    }
  }
}

/** The last wallet that connected, so a return visit lands where it left off. */
export const rememberWallet = (owner: string): void => write(`${NS}:last`, owner.toLowerCase());
export const lastWallet = (): string | null => read<string>(`${NS}:last`);
export const forgetWallet = (): void => {
  try {
    store().removeItem(`${NS}:last`);
  } catch {
    /* nothing to do */
  }
};

/**
 * An identity for someone with no wallet.
 *
 * Shadow Mode never signs and never spends — the address is only a key under
 * which to file a policy. Demanding a browser extension for that turned "anyone
 * can watch Rivo manage a portfolio" into "anyone who has already installed
 * MetaMask can", which is a much smaller group and a barrier we imposed for no
 * reason of our own.
 *
 * Deliberately shaped like an address so every downstream check — parsePolicy,
 * the registry's isolation key, the storage namespace — treats it identically
 * and nothing needs a special case. The `0xde…` prefix marks it as a demo so the
 * UI can say so, and it can never collide with a real wallet: the remaining
 * bytes are random and no one holds the private key, because none was generated.
 */
export function demoIdentity(): `0x${string}` {
  const existing = read<string>(`${NS}:demo`);
  if (existing && /^0xde[0-9a-f]{38}$/.test(existing)) return existing as `0x${string}`;
  const bytes = new Uint8Array(19);
  (globalThis.crypto ?? { getRandomValues: (a: Uint8Array) => a.map(() => Math.floor(Math.random() * 256)) })
    .getRandomValues(bytes);
  const id = `0xde${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}` as `0x${string}`;
  write(`${NS}:demo`, id);
  return id;
}

/** Whether an identity is a local demo rather than a connected wallet. */
export const isDemo = (owner: string): boolean => owner.toLowerCase().startsWith("0xde");
