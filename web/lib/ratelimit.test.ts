// The rate limiter.
//
// Small enough to reason about, and worth pinning anyway: the failure mode of a
// limiter is that it looks like it works and lets twice the intended rate
// through at exactly the boundary.

import { beforeEach, describe, expect, it } from "vitest";
import { reset, take, WRITE_LIMIT, type Limit } from "./ratelimit";

const LIMIT: Limit = { max: 3, windowMs: 1_000 };

beforeEach(reset);

describe("taking a token", () => {
  it("allows up to the limit and then refuses", () => {
    for (let i = 0; i < LIMIT.max; i++) expect(take("a", LIMIT, 1000).ok).toBe(true);
    const refused = take("a", LIMIT, 1000);
    expect(refused.ok).toBe(false);
    expect(refused.remaining).toBe(0);
    expect(refused.retryAfter).toBeGreaterThan(0);
  });

  it("counts each caller separately", () => {
    for (let i = 0; i < LIMIT.max; i++) take("a", LIMIT, 1000);
    expect(take("a", LIMIT, 1000).ok).toBe(false);
    // One user hitting their ceiling must not affect anybody else.
    expect(take("b", LIMIT, 1000).ok).toBe(true);
  });

  it("slides rather than resetting on a boundary", () => {
    // The bug a fixed window has: `max` at the end of one window and `max` at
    // the start of the next is twice the intended rate, back to back.
    //
    // The requests are STAGGERED, which is the whole point — three sent at the
    // same instant expire at the same instant, and a test that sends them
    // together proves nothing about sliding. These expire one at a time.
    take("a", LIMIT, 1000);
    take("a", LIMIT, 1200);
    take("a", LIMIT, 1400);
    expect(take("a", LIMIT, 1500).ok).toBe(false);

    // Just past the first request's expiry: exactly one slot frees up.
    expect(take("a", LIMIT, 2001).ok).toBe(true);
    expect(take("a", LIMIT, 2001).ok).toBe(false);

    // And past the second's, one more — not the whole allowance.
    expect(take("a", LIMIT, 2201).ok).toBe(true);
    expect(take("a", LIMIT, 2201).ok).toBe(false);
  });

  it("recovers fully once the window has passed", () => {
    for (let i = 0; i < LIMIT.max; i++) take("a", LIMIT, 1000);
    for (let i = 0; i < LIMIT.max; i++) expect(take("a", LIMIT, 5000).ok).toBe(true);
  });

  it("tells the caller how long to wait, and it is not zero", () => {
    for (let i = 0; i < LIMIT.max; i++) take("a", LIMIT, 1000);
    const v = take("a", LIMIT, 1500);
    expect(v.retryAfter).toBeGreaterThanOrEqual(1);
    expect(v.retryAfter).toBeLessThanOrEqual(Math.ceil(LIMIT.windowMs / 1000));
  });

  it("ships a write limit a person cannot hit by using the product", () => {
    // Thirty changes a minute is far more than a human clicking Save, and far
    // less than a retry loop. A limit tight enough to annoy a real user is a
    // limit that gets removed.
    expect(WRITE_LIMIT.max).toBeGreaterThanOrEqual(20);
    expect(WRITE_LIMIT.windowMs).toBe(60_000);
  });
});
