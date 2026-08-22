// Input validation, at the edge.
//
// Hand-written rather than schema-library-shaped, for one reason: the surface is
// small and every field has a real constraint that comes from the product rather
// than from a type. Capital is money and cannot be negative or infinite; a
// profile is one of three names; an override is a fraction between zero and one.
// Those are worth stating explicitly where somebody will read them.
//
// Everything here REJECTS rather than coerces. A capital of `"50abc"` is not
// fifty — it is a bug in whatever sent it, and quietly parsing it to fifty is how
// a client bug becomes a trading bug.

import { PROFILES, type ProfileName } from "@rivo/portfolio/profiles.js";
import type { PolicyOverrides } from "@rivo/portfolio/policy.js";

/**
 * One of the three profiles, and nothing else.
 *
 * `Object.hasOwn` rather than `in`, because `in` walks the prototype chain: the
 * first version of this accepted `"__proto__"`, `"constructor"` and `"toString"`
 * as valid profile names. The database's CHECK constraint would have caught
 * those on the way in, which is exactly the kind of second line of defence that
 * should never be the first one to notice.
 */
export const isProfile = (v: unknown): v is ProfileName => typeof v === "string" && Object.hasOwn(PROFILES, v);

/** A finite, non-negative amount of money, with a ceiling that is not a type limit. */
export function amount(v: unknown, field: string, max = 1_000_000): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) throw new Error(`${field} must be a number`);
  if (n < 0) throw new Error(`${field} cannot be negative`);
  if (n > max) throw new Error(`${field} is above the ${max} limit this deployment allows`);
  return n;
}

/** A fraction of capital. Zero is meaningful (deploy nothing); above one is not. */
export function fraction(v: unknown, field: string): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) throw new Error(`${field} must be a number`);
  if (n < 0 || n > 1) throw new Error(`${field} must be between 0 and 1`);
  return n;
}

/**
 * The overrides a user may set.
 *
 * An allowlist, not a filter. Anything not named here is dropped rather than
 * passed through, so a client that invents a field cannot write it into a
 * policy — and `parsePolicy` on the way back out drops it again if one ever
 * did. Two layers, because this one is the one that can be reasoned about and
 * that one is the one that cannot be bypassed.
 */
export function overrides(v: unknown): PolicyOverrides {
  if (v === null || v === undefined) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw new Error("overrides must be an object");
  const input = v as Record<string, unknown>;
  const out: PolicyOverrides = {};
  const fractional: (keyof PolicyOverrides)[] = [
    "maxDeployed",
    "maxPerPosition",
    "maxAssetDeltaPer1Pct",
    "maxCombinedDeltaPer1Pct",
    "maxPerExpiryBucket",
    "minEdge",
    "cashFloor",
  ];
  for (const key of fractional) {
    if (input[key] === undefined || input[key] === null) continue;
    (out as Record<string, number>)[key] = fraction(input[key], key);
  }
  if (input.maxPerTenor && typeof input.maxPerTenor === "object") {
    const tenors: Record<number, number> = {};
    for (const [k, val] of Object.entries(input.maxPerTenor as Record<string, unknown>)) {
      const seconds = Number(k);
      // Only real cadences. An arbitrary key here would sit in the policy
      // forever, matching nothing and confusing everything that reads it.
      if (!Number.isInteger(seconds) || seconds <= 0 || seconds > 86_400) continue;
      tenors[seconds] = fraction(val, `maxPerTenor[${k}]`);
    }
    if (Object.keys(tenors).length > 0) out.maxPerTenor = tenors;
  }
  return out;
}

/** A JSON body, or a clear error. An empty body is `{}`, not a crash. */
export async function jsonBody(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.trim().length === 0) return {};
  // A megabyte is four orders of magnitude more than any request this app makes.
  if (text.length > 1_000_000) throw new Error("request body is too large");
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("body must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (e) {
    throw new Error(e instanceof SyntaxError ? "body is not valid JSON" : String(e instanceof Error ? e.message : e));
  }
}
