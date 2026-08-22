// A ceiling on how fast one user can change things.
//
// WHAT THIS IS FOR, precisely, because the honest scope is narrow. Every
// mutating route here is authenticated and scoped to one user, and the expensive
// work — a trading cycle — is not reachable from a request at all; it belongs to
// the worker, on a schedule the API cannot influence. So the damage an
// authenticated user can do by looping a request is bounded by their own rows.
//
// It is still worth having. A client with a bad retry loop can write a thousand
// policy updates a minute, and each one is a database round trip that everybody
// else's requests then queue behind. This turns that into a 429.
//
// WHAT IT IS NOT. In-memory, therefore PER INSTANCE. On Vercel that means the
// limit is per serverless instance rather than global, so a burst spread across
// cold starts sees a higher effective ceiling. That is a real weakening and it
// is written down here rather than in a footnote — a deployment that needs a
// hard global limit needs a shared store or a limiter at the edge, and this is
// the floor beneath that rather than a replacement for it.

/** One user's recent request timestamps, in milliseconds. */
const seen = new Map<string, number[]>();

/** Stop the map growing without bound in a long-lived instance. */
const MAX_TRACKED = 10_000;

export interface Limit {
  /** How many requests are allowed in the window. */
  max: number;
  /** The window, in milliseconds. */
  windowMs: number;
}

/** Mutating routes: generous for a person, tight against a retry loop. */
export const WRITE_LIMIT: Limit = { max: 30, windowMs: 60_000 };

export interface Verdict {
  ok: boolean;
  /** Seconds until the caller may retry. Only meaningful when `ok` is false. */
  retryAfter: number;
  remaining: number;
}

/**
 * Take one token for `key`, or refuse.
 *
 * A sliding window rather than a fixed one: a fixed window lets a caller send
 * `max` at 59 seconds and `max` again at 61, which is twice the intended rate at
 * exactly the moment it matters.
 */
export function take(key: string, limit: Limit = WRITE_LIMIT, now = Date.now()): Verdict {
  if (seen.size > MAX_TRACKED) seen.clear();
  const cutoff = now - limit.windowMs;
  const recent = (seen.get(key) ?? []).filter((t) => t > cutoff);
  if (recent.length >= limit.max) {
    const oldest = recent[0]!;
    seen.set(key, recent);
    return { ok: false, retryAfter: Math.max(1, Math.ceil((oldest + limit.windowMs - now) / 1000)), remaining: 0 };
  }
  recent.push(now);
  seen.set(key, recent);
  return { ok: true, retryAfter: 0, remaining: limit.max - recent.length };
}

/** Tests, and a deployment that wants a clean slate. */
export function reset(): void {
  seen.clear();
}
