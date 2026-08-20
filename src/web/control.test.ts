// The check between a stranger and a live trading runtime.
//
// This server can spawn a runtime that places real orders with the operator's
// key, so reaching its control endpoints is equivalent to holding that key. Node
// binds every interface when given no host, which on any machine with a routable
// address would have published that capability with nothing in front of it.

import { describe, expect, it } from "vitest";
import { isLoopback, MIN_TOKEN_LENGTH, tokenAccepted } from "./server.js";

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
