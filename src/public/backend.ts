// Talking to a Rivo backend, when there is one.
//
// Shadow Mode needs no backend: the engine runs in the tab. Autopilot does, and
// not for architectural neatness — because signing an order at 3am requires a key
// held by something that is awake, and a browser tab is not that. See wallet.ts.
//
// So this module's job is mostly to establish, honestly, whether Autopilot is
// available at all, and to say why not when it is not. A product that offers a
// button it cannot honour is worse than one that explains the gap.
//
// Discovery order: an explicit `?backend=` parameter, then a same-origin server,
// then localhost for someone running `npm run web` beside the page. Every probe
// is short and failure is the expected case, so a missing backend costs a moment
// and never blocks the page.

import type { PortfolioPolicy } from "../portfolio/policy.js";
import type { AuthorityDescription } from "../runtime/signer.js";

export interface BackendStatus {
  url: string;
  /** Whether the process holds a signing authority and could run Autopilot. */
  canTrade: boolean;
  authority: AuthorityDescription;
  /** Whether a runtime is currently executing. */
  running: boolean;
  network: string;
  version?: string;
}

export interface BackendPortfolio {
  policy: PortfolioPolicy;
  state: unknown;
}

const TIMEOUT_MS = 2500;

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Candidate backends, most specific first. */
function candidates(): string[] {
  const out: string[] = [];
  try {
    const explicit = new URLSearchParams(globalThis.location?.search ?? "").get("backend");
    if (explicit) out.push(explicit.replace(/\/$/, ""));
  } catch {
    /* no location, e.g. a test environment */
  }
  const origin = globalThis.location?.origin;
  // A file:// page has origin "null" as a STRING, which would build a request to
  // "null/api/..." and throw rather than fail cleanly.
  if (origin && origin !== "null" && /^https?:/.test(origin)) out.push(origin);
  for (const port of [3000, 3117]) out.push(`http://localhost:${port}`);
  return [...new Set(out)];
}

/**
 * Find a backend, or return null.
 *
 * Probes run in parallel and the first healthy one wins, so a page loaded next
 * to a dead localhost does not wait out every timeout in sequence.
 */
export async function discover(): Promise<BackendStatus | null> {
  const probes = candidates().map(async (url): Promise<BackendStatus | null> => {
    try {
      const h = await request<Omit<BackendStatus, "url">>(`${url}/api/health`);
      // Same-origin static hosting will answer 200 with the HTML shell for any
      // path; requiring the field we actually need rejects that.
      if (!h || typeof h.canTrade !== "boolean") return null;
      return { ...h, url };
    } catch {
      return null;
    }
  });
  for (const found of await Promise.all(probes)) if (found) return found;
  return null;
}

export const command = (base: string, owner: string, action: "start" | "pause" | "stop"): Promise<BackendPortfolio> =>
  request(`${base}/api/portfolio/${owner.toLowerCase()}/${action}`, { method: "POST" });

/** Why Autopilot is unavailable, in the terms the UI should use. */
export function autopilotBlocker(status: BackendStatus | null): string | null {
  if (!status) {
    return "No Rivo backend is reachable from this page. Shadow Mode runs entirely here in the browser; Autopilot needs a process that stays awake to sign, settle and claim — run `npm run web` locally and reload.";
  }
  if (!status.canTrade) {
    return status.authority?.missing
      ? `The backend is running but holds no signing authority: ${status.authority.missing}.`
      : "The backend is running but holds no signing authority.";
  }
  return null;
}
