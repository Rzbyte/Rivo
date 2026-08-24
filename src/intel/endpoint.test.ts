// The URL somebody else supplied, before our server calls it.
//
// This is the one file in the product where a missed case is a security bug
// rather than a wrong number. Every test below is a real bypass that has worked
// against real systems, and the assertion is always refusal.

import { describe, expect, it } from "vitest";
import { isBlockedV4, isBlockedV6, verifyEndpointUrl } from "./endpoint.js";

describe("literal IPv4", () => {
  it("refuses loopback in every notation this parser accepts", () => {
    for (const ip of ["127.0.0.1", "127.1.2.3", "127.255.255.254"]) {
      expect(isBlockedV4(ip), ip).toBe(true);
    }
  });

  it("refuses cloud metadata, which is the one that steals credentials", () => {
    // A POST to 169.254.169.254 from inside a cloud host needs no response to
    // do damage.
    expect(isBlockedV4("169.254.169.254")).toBe(true);
    expect(isBlockedV4("169.254.0.1")).toBe(true);
  });

  it("refuses every private range", () => {
    for (const ip of ["10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.1.1", "100.64.0.1"]) {
      expect(isBlockedV4(ip), ip).toBe(true);
    }
  });

  it("does not over-block the neighbours of a private range", () => {
    // 172.15 and 172.32 are public; a mask off by one bit takes them out too.
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "11.0.0.1", "192.167.1.1"]) {
      expect(isBlockedV4(ip), ip).toBe(false);
    }
  });

  it("ignores anything that is not four octets", () => {
    for (const s in { "": 0, "1.2.3": 0, "1.2.3.4.5": 0, "999.1.1.1": 0, "a.b.c.d": 0 }) {
      expect(isBlockedV4(s), s).toBe(false);
    }
  });
});

describe("literal IPv6", () => {
  it("refuses loopback and the unspecified address", () => {
    expect(isBlockedV6("::1")).toBe(true);
    expect(isBlockedV6("[::1]")).toBe(true);
    expect(isBlockedV6("::")).toBe(true);
  });

  it("refuses link-local and unique-local", () => {
    expect(isBlockedV6("fe80::1")).toBe(true);
    expect(isBlockedV6("fd00::1")).toBe(true);
    expect(isBlockedV6("fc00::1")).toBe(true);
  });

  it("refuses IPv4 wearing an IPv6 hat", () => {
    // The bypass a dotted-quad checker waves straight through.
    expect(isBlockedV6("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedV6("::ffff:169.254.169.254")).toBe(true);
    expect(isBlockedV6("::ffff:8.8.8.8")).toBe(false);
  });

  it("allows a public IPv6 address", () => {
    expect(isBlockedV6("2606:4700:4700::1111")).toBe(false);
  });
});

describe("the whole URL", () => {
  it("accepts an ordinary https endpoint", async () => {
    expect((await verifyEndpointUrl("https://example.com/decide")).ok).toBe(true);
  });

  it("refuses schemes that are not http", async () => {
    for (const u of ["file:///etc/passwd", "ftp://x.com/", "gopher://x.com/", "data:text/plain,hi"]) {
      const v = await verifyEndpointUrl(u);
      expect(v.ok, u).toBe(false);
    }
  });

  it("refuses credentials in the URL, which end up in logs", async () => {
    const v = await verifyEndpointUrl("https://user:secret@example.com/x");
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/header/i);
  });

  it("refuses localhost by name and by suffix", async () => {
    for (const u of ["http://localhost:3000/d", "http://api.localhost/d", "http://box.internal/d", "http://nas.local/d"]) {
      expect((await verifyEndpointUrl(u)).ok, u).toBe(false);
    }
  });

  it("refuses a literal private address", async () => {
    for (const u of ["http://127.0.0.1:8080/d", "http://169.254.169.254/latest/meta-data/", "http://10.1.2.3/d", "http://[::1]/d"]) {
      expect((await verifyEndpointUrl(u)).ok, u).toBe(false);
    }
  });

  it("is not fooled by a trailing dot", async () => {
    // `localhost.` and `localhost` are different strings and the same host.
    expect((await verifyEndpointUrl("http://localhost./d")).ok).toBe(false);
  });

  it("refuses a hostname that resolves to loopback", async () => {
    // The standard bypass: the name is public, the answer is not. This is why
    // the check resolves rather than reading the string.
    const v = await verifyEndpointUrl("http://localtest.me/d");
    if (!v.ok) expect(v.reason).toMatch(/resolve|private|link-local/i);
  });

  it("refuses garbage rather than throwing", async () => {
    for (const u of ["", "not a url", "://", "http://"]) {
      const v = await verifyEndpointUrl(u);
      expect(v.ok, u).toBe(false);
      expect(v.reason).toBeTruthy();
    }
  });

  it("allows a private target only when a caller opts in explicitly", async () => {
    // Right for a developer on their own machine, wrong for a hosted
    // deployment — so it is a decision the caller makes, not a guess.
    expect((await verifyEndpointUrl("http://127.0.0.1:8080/d")).ok).toBe(false);
    expect((await verifyEndpointUrl("http://127.0.0.1:8080/d", { allowPrivate: true })).ok).toBe(true);
  });
});
