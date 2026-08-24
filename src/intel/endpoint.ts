// Vetting a URL somebody else supplied, before our server calls it.
//
// An agent endpoint is a builder-controlled address that Rivo's own process will
// fetch — which is the exact shape of a server-side request forgery. The
// dangerous version of this feature is a one-line `fetch(userInput)`: the
// attacker does not need Rivo to return the body, only to make the request. A
// POST to `http://169.254.169.254/latest/meta-data/iam/security-credentials/`
// from inside a cloud host is a credential theft with no response needed.
//
// So the rule is an ALLOW list of shapes, not a deny list of known-bad strings.
// A deny list is a promise to have thought of everything, and the history of
// this class of bug is a history of encodings nobody thought of: decimal IPs,
// IPv6-mapped IPv4, trailing dots, redirects that land somewhere else.
//
// Two of those are handled here and one deliberately is not:
//
//   * The literal address is checked, in every notation this parser accepts.
//   * DNS is resolved and the ANSWER is checked, because `evil.com` pointing at
//     127.0.0.1 is the standard bypass.
//   * Redirects are not followed at all — `redirect: "manual"` at the call
//     site — because a target that resolves publicly and then 302s to metadata
//     defeats any amount of pre-flight checking.

import { lookup } from "node:dns/promises";

export interface EndpointVerdict {
  ok: boolean;
  /** Present when refused. Written for the builder, not for a log. */
  reason?: string;
}

/** Only these. `file:`, `ftp:`, `gopher:` and the rest are not agent endpoints. */
const SCHEMES = new Set(["https:", "http:"]);

/**
 * Private, loopback, link-local and carrier-grade ranges, as CIDRs.
 *
 * `169.254.0.0/16` is the one that matters most: every major cloud puts its
 * instance-credential service there.
 */
const BLOCKED_V4: [string, number][] = [
  ["0.0.0.0", 8],        // "this" network
  ["10.0.0.0", 8],       // private
  ["100.64.0.0", 10],    // carrier-grade NAT
  ["127.0.0.0", 8],      // loopback
  ["169.254.0.0", 16],   // link-local — cloud metadata lives here
  ["172.16.0.0", 12],    // private
  ["192.0.0.0", 24],     // IETF protocol assignments
  ["192.168.0.0", 16],   // private
  ["198.18.0.0", 15],    // benchmarking
  ["224.0.0.0", 4],      // multicast
  ["240.0.0.0", 4],      // reserved
];

const toLong = (ip: string): number | null => {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
};

/** Is this literal IPv4 address in a range we refuse to call? */
export function isBlockedV4(ip: string): boolean {
  const addr = toLong(ip);
  if (addr === null) return false;
  return BLOCKED_V4.some(([base, bits]) => {
    const b = toLong(base);
    if (b === null) return false;
    const mask = bits === 0 ? 0 : (0xffff_ffff << (32 - bits)) >>> 0;
    return (addr & mask) === (b & mask);
  });
}

/**
 * IPv6, including the two notations that carry an IPv4 address inside them.
 *
 * `::ffff:127.0.0.1` is loopback wearing a different hat, and a checker that
 * only looks at dotted quads waves it through.
 */
export function isBlockedV6(ip: string): boolean {
  const a = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (a === "::1" || a === "::") return true;
  if (a.startsWith("fe80") || a.startsWith("fc") || a.startsWith("fd")) return true; // link-local, unique-local
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) return isBlockedV4(mapped[1]!);
  return false;
}

const isLiteralIp = (host: string): boolean => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");

/**
 * May Rivo's server call this URL?
 *
 * Resolves DNS as part of the check, because a hostname is only as safe as what
 * it points at today. That leaves a rebinding window between this check and the
 * request, which is why the caller also refuses redirects and uses a short
 * timeout — defence that does not depend on the name still meaning what it
 * meant a second ago.
 */
export async function verifyEndpointUrl(raw: string, opts: { allowPrivate?: boolean } = {}): Promise<EndpointVerdict> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "That is not a URL Rivo can parse." };
  }

  if (!SCHEMES.has(url.protocol)) {
    return { ok: false, reason: `Rivo calls https and http endpoints only, not ${url.protocol.replace(":", "")}.` };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "Put credentials in a header, not in the URL — a URL ends up in logs." };
  }
  // Trailing dots make `example.com.` and `example.com` different strings and
  // the same host, which is a good way to get past a string comparison.
  const host = url.hostname.replace(/\.$/, "").toLowerCase();
  if (host === "") return { ok: false, reason: "That URL has no host." };

  // A local endpoint is right for a developer testing on their own machine and
  // wrong for a hosted deployment, so it is an explicit opt-in rather than a
  // guess about which one this is.
  if (opts.allowPrivate) return { ok: true };

  if (isLiteralIp(host)) {
    if (isBlockedV4(host) || isBlockedV6(host)) {
      return { ok: false, reason: "That address is inside a private or link-local range. Rivo will not call it." };
    }
    return { ok: true };
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    return { ok: false, reason: "Rivo cannot reach a name that only resolves on your own network." };
  }

  // Resolve, and judge the answer rather than the name. `evil.com` pointing at
  // 127.0.0.1 is the standard way past a check that only reads the string.
  try {
    const addrs = await lookup(host, { all: true });
    if (addrs.length === 0) return { ok: false, reason: "That hostname does not resolve." };
    for (const a of addrs) {
      const blocked = a.family === 4 ? isBlockedV4(a.address) : isBlockedV6(a.address);
      if (blocked) {
        return { ok: false, reason: "That hostname resolves to a private or link-local address. Rivo will not call it." };
      }
    }
  } catch {
    return { ok: false, reason: "That hostname does not resolve." };
  }
  return { ok: true };
}
