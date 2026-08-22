// The trust boundary.
//
// These routes are where a bearer token becomes an identity and a portfolio id
// becomes somebody's portfolio. Everything below is about the two ways that can
// go wrong — accepting a request it should refuse, and telling a caller
// something it should not know.
//
// The Privy verifier is stubbed, because what is under test is Rivo's handling
// of the answer rather than Privy's ability to check a signature. The database
// is real: an ownership check that passes against a mock is a mock of an
// ownership check.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted, so the mock is in place before the route modules import it.
const verify = vi.hoisted(() => vi.fn<(token: string) => Promise<{ userId: string } | null>>());
vi.mock("@rivo/signing/privy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/signing/privy.js")>();
  return { ...actual, verifyAccessToken: verify, privyConfigured: () => true };
});

import { haveDatabase, seedPortfolio, truncateAll, withSchema } from "@rivo/db/testing.js";
import { upsertUser } from "@rivo/db/accounts.js";
import { query } from "@rivo/db/pool.js";
import { amount, fraction, isProfile, jsonBody, overrides } from "./validate";

const get = (path: string, token?: string) =>
  new Request(`http://rivo.test${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

const patch = (path: string, token: string, body: unknown) =>
  new Request(`http://rivo.test${path}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("input validation", () => {
  it("rejects rather than coerces", () => {
    expect(() => amount("50abc", "capital")).toThrow(/must be a number/);
    expect(() => amount(-1, "capital")).toThrow(/negative/);
    expect(() => amount(Number.POSITIVE_INFINITY, "capital")).toThrow(/must be a number/);
    expect(() => amount(NaN, "capital")).toThrow(/must be a number/);
    expect(amount("50", "capital")).toBe(50);
  });

  it("caps an amount at something a deployment can survive", () => {
    expect(() => amount(1e9, "capital")).toThrow(/limit/);
  });

  it("holds fractions to zero-to-one", () => {
    expect(fraction(0, "x")).toBe(0);
    expect(fraction(1, "x")).toBe(1);
    expect(() => fraction(1.5, "x")).toThrow(/between 0 and 1/);
    expect(() => fraction(-0.1, "x")).toThrow(/between 0 and 1/);
  });

  it("drops override fields nobody named", () => {
    const out = overrides({ maxPerPosition: 0.2, evil: 1, __proto__: { polluted: true } });
    expect(out.maxPerPosition).toBe(0.2);
    expect((out as Record<string, unknown>).evil).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("ignores tenor keys that are not cadences", () => {
    const out = overrides({ maxPerTenor: { "900": 0.2, "not-a-number": 0.5, "-5": 0.5, "999999": 0.5 } });
    expect(out.maxPerTenor).toEqual({ 900: 0.2 });
  });

  it("knows the three profiles and nothing else", () => {
    expect(isProfile("balanced")).toBe(true);
    expect(isProfile("aggressive")).toBe(false);
    expect(isProfile("__proto__")).toBe(false);
  });

  it("treats an empty body as an empty object, and refuses an array", async () => {
    expect(await jsonBody(new Request("http://x/", { method: "POST" }))).toEqual({});
    await expect(
      jsonBody(new Request("http://x/", { method: "POST", body: "[1,2,3]" })),
    ).rejects.toThrow(/JSON object/);
    await expect(jsonBody(new Request("http://x/", { method: "POST", body: "{oops" }))).rejects.toThrow(
      /not valid JSON/,
    );
  });
});

describe.skipIf(!haveDatabase())("the API's ownership boundary", () => {
  let teardown: () => Promise<void>;
  let owner: { userId: string; portfolioId: string };
  let intruderToken: string;

  beforeAll(async () => {
    teardown = await withSchema("api");
  });
  afterAll(async () => {
    await teardown();
  });
  beforeEach(async () => {
    await truncateAll();
    owner = await seedPortfolio();
    const [row] = await query<{ privy_did: string }>("SELECT privy_did FROM users WHERE id = $1", [owner.userId]);
    ownerToken = row!.privy_did;
    const intruder = await upsertUser("did:privy:intruder");
    intruderToken = intruder.privyDid;
    verify.mockImplementation(async (token: string) =>
      token === ownerToken || token === intruderToken ? { userId: token } : null,
    );
  });
  afterEach(() => verify.mockReset());

  let ownerToken = "";

  it("refuses a request with no token", async () => {
    const { GET } = await import("../app/api/portfolios/route");
    const res = await GET(get("/api/portfolios"), undefined as never);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "not signed in" });
  });

  it("refuses a token Privy does not recognise", async () => {
    const { GET } = await import("../app/api/portfolios/route");
    const res = await GET(get("/api/portfolios", "forged"), undefined as never);
    expect(res.status).toBe(401);
  });

  it("refuses a token in the wrong scheme", async () => {
    const { GET } = await import("../app/api/portfolios/route");
    const req = new Request("http://rivo.test/api/portfolios", { headers: { authorization: ownerToken } });
    expect((await GET(req, undefined as never)).status).toBe(401);
  });

  it("shows the owner their portfolio", async () => {
    const { GET } = await import("../app/api/portfolios/[id]/route");
    const res = await GET(get(`/api/portfolios/${owner.portfolioId}`, ownerToken), {
      params: Promise.resolve({ id: owner.portfolioId }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { view: { id: string } };
    expect(body.view.id).toBe(owner.portfolioId);
  });

  it("gives another user a 404, not a 403", async () => {
    // A 403 confirms the portfolio exists. For an id somebody guessed, that is
    // information they did not have a moment ago.
    const { GET } = await import("../app/api/portfolios/[id]/route");
    const res = await GET(get(`/api/portfolios/${owner.portfolioId}`, intruderToken), {
      params: Promise.resolve({ id: owner.portfolioId }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "no such portfolio" });
  });

  it("will not let another user change a portfolio's capital", async () => {
    const { PATCH } = await import("../app/api/portfolios/[id]/route");
    const res = await PATCH(patch(`/api/portfolios/${owner.portfolioId}`, intruderToken, { capital: 999999 }), {
      params: Promise.resolve({ id: owner.portfolioId }),
    });
    expect(res.status).toBe(404);
    const [after] = await query<{ capital: string }>("SELECT capital FROM portfolios WHERE id = $1", [
      owner.portfolioId,
    ]);
    expect(Number(after!.capital)).toBe(50);
  });

  it("will not let another user enable Autopilot on it", async () => {
    const { POST } = await import("../app/api/portfolios/[id]/autopilot/route");
    const req = new Request(`http://rivo.test/api/portfolios/${owner.portfolioId}/autopilot`, {
      method: "POST",
      headers: { authorization: `Bearer ${intruderToken}`, "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, delegated: true }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: owner.portfolioId }) });
    expect(res.status).toBe(404);
  });

  it("refuses to enable Autopilot without the consent step", async () => {
    const { POST } = await import("../app/api/portfolios/[id]/autopilot/route");
    const req = new Request(`http://rivo.test/api/portfolios/${owner.portfolioId}/autopilot`, {
      method: "POST",
      headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: owner.portfolioId }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/permission to sign/i);
  });

  it("switches Autopilot off without needing anything from the browser", async () => {
    // The asymmetry that matters: turning it ON requires a consent step that can
    // fail, and turning it OFF must not depend on anything succeeding.
    const { POST } = await import("../app/api/portfolios/[id]/autopilot/route");
    const req = new Request(`http://rivo.test/api/portfolios/${owner.portfolioId}/autopilot`, {
      method: "POST",
      headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: owner.portfolioId }) });
    expect(res.status).toBe(200);
    const [w] = await query<{ delegated: boolean }>(
      "SELECT delegated FROM wallets w JOIN portfolios p ON p.wallet_id = w.id WHERE p.id = $1",
      [owner.portfolioId],
    );
    expect(w!.delegated).toBe(false);
    const [p] = await query<{ state: string }>("SELECT state FROM portfolios WHERE id = $1", [owner.portfolioId]);
    expect(p!.state).toBe("stopped");
  });

  it("cannot be talked into promoting an external wallet into a signer", async () => {
    // Someone re-posting their hardware wallet as `kind: portfolio` must not end
    // up with Rivo holding authority over it.
    const { POST } = await import("../app/api/me/route");
    const address = "0x9999999999999999999999999999999999999999";
    const external = new Request("http://rivo.test/api/me", {
      method: "POST",
      headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ address, kind: "external" }),
    });
    expect((await POST(external, undefined as never)).status).toBe(200);

    const promote = new Request("http://rivo.test/api/me", {
      method: "POST",
      headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ address, kind: "portfolio", privyWalletId: "pw_attacker" }),
    });
    await POST(promote, undefined as never);

    const [row] = await query<{ kind: string }>("SELECT kind FROM wallets WHERE address = $1", [address]);
    expect(row!.kind).toBe("external");
  });

  it("rejects an address that is not one", async () => {
    const { POST } = await import("../app/api/me/route");
    const req = new Request("http://rivo.test/api/me", {
      method: "POST",
      headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ address: "not-an-address", kind: "external" }),
    });
    const res = await POST(req, undefined as never);
    expect(res.status).toBe(400);
  });
});
