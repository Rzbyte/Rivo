// The only path from a request to an identity.
//
// One function, called by every route that touches user data, so there is one
// thing to audit rather than one per endpoint. It does three things and refuses
// to do a fourth:
//
//   * verifies the Privy access token, which is the only credential Rivo accepts;
//   * finds or creates the user behind it;
//   * hands the route a user id.
//
// It does NOT resolve a portfolio. That is deliberate: every portfolio lookup in
// this app takes a user id as well as a portfolio id, so a route that forgets to
// check ownership finds nothing instead of succeeding against somebody else's
// data. Making the user available without also making the portfolio available is
// what keeps that discipline mechanical rather than remembered.

import { NextResponse } from "next/server";
import { verifyAccessToken } from "@rivo/signing/privy.js";
import { upsertUser, type User } from "@rivo/db/accounts.js";
import { configured } from "@rivo/db/pool.js";
import { take } from "./ratelimit";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The bearer token on a request, or null. */
function bearer(req: Request): string | null {
  const header = req.headers.get("authorization") ?? "";
  if (!header.toLowerCase().startsWith("bearer ")) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

/**
 * The authenticated user, or a thrown 401.
 *
 * Throws rather than returning null so that a route cannot proceed by ignoring
 * the result. `withUser` below turns the throw back into a response.
 */
export async function requireUser(req: Request): Promise<User> {
  if (!configured()) {
    throw new HttpError(503, "this deployment has no database configured");
  }
  const token = bearer(req);
  if (!token) throw new HttpError(401, "not signed in");
  const claims = await verifyAccessToken(token);
  if (!claims) throw new HttpError(401, "not signed in");
  return upsertUser(claims.userId);
}

/**
 * Wrap a handler, rate-limited per user.
 *
 * Only for routes that CHANGE something. Reads are left alone deliberately: the
 * dashboard polls, and a limiter that fought the product's own refresh would be
 * a limiter somebody eventually removes.
 */
export function withUserWrite<T>(
  handler: (user: User, req: Request, ctx: T) => Promise<Response>,
): (req: Request, ctx: T) => Promise<Response> {
  return withUser(async (user, req, ctx) => {
    const verdict = take(`user:${user.id}`);
    if (!verdict.ok) {
      return NextResponse.json(
        { error: "too many changes in a short time — slow down and try again" },
        { status: 429, headers: { "retry-after": String(verdict.retryAfter) } },
      );
    }
    return handler(user, req, ctx);
  });
}

/**
 * Wrap a handler so that thrown errors become responses.
 *
 * The `catch` deliberately does NOT put an unexpected error's message in the
 * response. A stack trace or a database error string reaching a browser is how
 * schema names, file paths and occasionally connection strings end up in
 * somebody's console; the server log is where that belongs.
 */
export function withUser<T>(
  handler: (user: User, req: Request, ctx: T) => Promise<Response>,
): (req: Request, ctx: T) => Promise<Response> {
  return async (req: Request, ctx: T) => {
    try {
      const user = await requireUser(req);
      return await handler(user, req, ctx);
    } catch (e) {
      if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
      console.error("unhandled error in route:", e);
      return NextResponse.json({ error: "something went wrong" }, { status: 500 });
    }
  };
}

/** 404 for anything a user does not own. Never 403 — that confirms it exists. */
export const notFound = (): never => {
  throw new HttpError(404, "no such portfolio");
};

export const badRequest = (message: string): never => {
  throw new HttpError(400, message);
};
