// Which connections get TLS, and which do not.
//
// This is three lines of logic that silently broke twenty-one tests. The gate
// used to be "loopback AND no PGSSLMODE set", which fails the most ordinary
// development setup there is — a managed database in `.env`, so PGSSLMODE is
// set, and DATABASE_URL pointed at localhost to run the suite. It forced TLS
// against a server that has none and failed with "The server does not support
// SSL connections", a message naming neither the cause nor the fix.
//
// Worse, it surfaced as tests SKIPPING rather than failing: the error was in
// `beforeAll`, so vitest marked the file failed and every test inside it
// skipped. A count of passing tests looked almost right.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sslFor } from "./pool.js";

const LOCAL = "postgres://rivo@127.0.0.1:55432/rivo";
const LOCALHOST = "postgres://rivo@localhost:5432/rivo";
const IPV6 = "postgres://rivo@[::1]:5432/rivo";
const MANAGED = "postgres://u:p@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres";

describe("loopback", () => {
  it("never gets TLS, whatever PGSSLMODE says", () => {
    // The regression. Each of these was previously forced into TLS.
    for (const url of [LOCAL, LOCALHOST, IPV6]) {
      expect(sslFor(url, "", false), url).toBe(false);
      expect(sslFor(url, "no-verify", false), url).toBe(false);
      expect(sslFor(url, "require", false), url).toBe(false);
      expect(sslFor(url, "verify-full", false), url).toBe(false);
    }
  });
});

describe("anything not loopback", () => {
  it("verifies the certificate by default", () => {
    expect(sslFor(MANAGED, "", false)).toEqual({ rejectUnauthorized: true });
  });

  it("stops verifying only when explicitly told to", () => {
    // The documented escape hatch for a provider whose chain the container does
    // not carry. It must be a deliberate opt-out, not a default.
    expect(sslFor(MANAGED, "no-verify", false)).toEqual({ rejectUnauthorized: false });
    expect(sslFor(MANAGED, "NO-VERIFY", false)).toEqual({ rejectUnauthorized: false });
  });

  it("still verifies for a mode it does not recognise", () => {
    // Erring toward MORE verification for an unknown value, not less.
    expect(sslFor(MANAGED, "prefer", false)).toEqual({ rejectUnauthorized: true });
    expect(sslFor(MANAGED, "banana", false)).toEqual({ rejectUnauthorized: true });
  });
});

describe("turning TLS off entirely", () => {
  it("honours DATABASE_SSL=off and PGSSLMODE=disable", () => {
    expect(sslFor(MANAGED, "", true)).toBe(false);
    expect(sslFor(MANAGED, "disable", false)).toBe(false);
  });

  it("does not let an empty DATABASE_URL imply loopback", () => {
    // An unset URL is a configuration error, not a local database. Guessing
    // "local, so no TLS" there would silently downgrade a real connection.
    expect(sslFor("", "", false)).toEqual({ rejectUnauthorized: true });
  });

  it("does not match a host that merely contains 'localhost'", () => {
    // `localhost.evil.com` is not loopback.
    expect(sslFor("postgres://u:p@localhost.example.com:5432/db", "", false)).toEqual({
      rejectUnauthorized: true,
    });
  });
});

describe("the pool reads .env where it reads DATABASE_URL", () => {
  it("loads the environment on import, not only via core/config", () => {
    // `npm run report -- --portfolio <id>` answered "--portfolio needs
    // DATABASE_URL" against a database that was configured perfectly. The
    // variable lives in .env; core/config loads it on import with a comment
    // saying no entry point can forget to — and report.ts never imports config,
    // so it forgot. That is the most confusing shape a missing-configuration
    // error can take: correct configuration, reported as absent.
    const src = readFileSync(resolve("src/db/pool.ts"), "utf8");
    expect(src).toMatch(/import \{ loadEnv \} from "\.\.\/core\/env\.js"/);
    // Called at module scope, not inside a function that something has to reach.
    expect(src).toMatch(/\nloadEnv\(\);/);
  });

  it("does not overwrite a variable the platform already set", async () => {
    // Behaviour, not prose. The first version of this asserted a phrase in a
    // comment, which is the pattern that fails when somebody rewords a sentence
    // and passes when somebody breaks the code.
    //
    // This matters on Vercel and in Docker, where there is no .env and the
    // platform supplies the values: a loader that overwrote them would replace a
    // production connection string with whatever a stray file contained.
    const { loadEnv } = await import("../core/env.js");
    const key = "RIVO_ENV_OVERWRITE_PROBE";
    const before = process.env[key];
    try {
      process.env[key] = "set-by-the-platform";
      loadEnv();
      expect(process.env[key]).toBe("set-by-the-platform");
    } finally {
      if (before === undefined) delete process.env[key];
      else process.env[key] = before;
    }
  });
});
