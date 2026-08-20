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
