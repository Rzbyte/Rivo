// The check between a stranger and a live trading runtime.
//
// This server can spawn a runtime that places real orders with the operator's
// key, so reaching its control endpoints is equivalent to holding that key. Node
// binds every interface when given no host, which on any machine with a routable
// address would have published that capability with nothing in front of it.

import { describe, expect, it } from "vitest";
import { isLoopback, MIN_TOKEN_LENGTH, tokenAccepted, CORS } from "./server.js";

const TOKEN = "a-sufficiently-long-control-token";

describe("isLoopback", () => {
  it("recognises the addresses reachable only from this machine", () => {
    for (const h of ["127.0.0.1", "localhost", "::1", "127.5.5.5"]) expect(isLoopback(h)).toBe(true);
  });

  it("treats everything else as exposed — including the wildcard", () => {
    // 0.0.0.0 is the dangerous one: it reads like "nowhere" and means "everywhere".
    for (const h of ["0.0.0.0", "192.168.1.10", "::", "example.com"]) expect(isLoopback(h)).toBe(false);
  });
});

describe("tokenAccepted", () => {
  it("accepts a Bearer header", () => {
    expect(tokenAccepted({ authorization: `Bearer ${TOKEN}` }, TOKEN)).toBe(true);
  });

  it("accepts the x-rivo-token header, for callers that cannot set Authorization", () => {
    expect(tokenAccepted({ "x-rivo-token": TOKEN }, TOKEN)).toBe(true);
  });

  it("rejects a wrong, empty, or missing token", () => {
    expect(tokenAccepted({ authorization: "Bearer wrong" }, TOKEN)).toBe(false);
    expect(tokenAccepted({ authorization: "Bearer " }, TOKEN)).toBe(false);
    expect(tokenAccepted({}, TOKEN)).toBe(false);
  });

  it("rejects a correct PREFIX of the token", () => {
    // A length-first comparison that returned true on a prefix would turn the
    // token into a guessing game one character at a time.
    expect(tokenAccepted({ authorization: `Bearer ${TOKEN.slice(0, -1)}` }, TOKEN)).toBe(false);
    expect(tokenAccepted({ authorization: `Bearer ${TOKEN}x` }, TOKEN)).toBe(false);
  });

  it("ignores a malformed Authorization scheme rather than accepting the raw value", () => {
    expect(tokenAccepted({ authorization: TOKEN }, TOKEN)).toBe(false);
    expect(tokenAccepted({ authorization: `Basic ${TOKEN}` }, TOKEN)).toBe(false);
  });

  it("is open when no token is configured — the loopback-only case", () => {
    expect(tokenAccepted({}, "")).toBe(true);
  });

  it("requires a token long enough that guessing is not a strategy", () => {
    expect(MIN_TOKEN_LENGTH).toBeGreaterThanOrEqual(16);
  });
});

describe("the preflight admits the header the guard reads", () => {
  // A guard that cannot be satisfied is not a guard, it is a wall. The token
  // rides in `authorization` or `x-rivo-token`, and a browser will not send a
  // header the preflight did not name — so listing only content-type meant that
  // the moment a token was configured, which is MANDATORY off-loopback and
  // which compose.yaml requires, every control request was blocked before it
  // left the browser. The cockpit answered `canTrade: true` and then refused
  // every attempt, which is the worst shape a failure can take.
  const allowed = (): string[] =>
    String(CORS["access-control-allow-headers"] ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase());

  it("names every header the token can arrive in", () => {
    for (const h of ["authorization", "x-rivo-token"]) {
      expect(allowed(), `preflight must allow ${h}`).toContain(h);
    }
  });

  it("still allows the body type the control endpoints post", () => {
    expect(allowed()).toContain("content-type");
  });

  it("allows the methods those endpoints use", () => {
    const methods = String(CORS["access-control-allow-methods"] ?? "").toUpperCase();
    for (const m of ["GET", "POST", "OPTIONS"]) expect(methods).toContain(m);
  });
});
