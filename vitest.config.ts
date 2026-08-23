import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * The web app's imports, resolved the way Next resolves them.
 *
 * The API routes are a trust boundary — they are where a token becomes an
 * identity and where a portfolio id becomes somebody's portfolio — so they need
 * tests, and tests need the aliases. Duplicated from web/tsconfig.json because
 * vitest reads a config rather than a tsconfig; kept short enough that the
 * duplication is visible rather than buried.
 */
const alias = {
  "@rivo": fileURLToPath(new URL("./src", import.meta.url)),
  "@": fileURLToPath(new URL("./web", import.meta.url)),
};

export default defineConfig({
  resolve: { alias },
  test: {
    include: ["src/**/*.test.ts", "web/**/*.test.ts"],
    // These tests are pure: no network, no clock, no filesystem beyond a temp dir.
    // Anything that needs the venue belongs in the CLIs, which are exercised by
    // running them against it — a unit test that depends on a live order book
    // fails for reasons that have nothing to do with the code under test.
    environment: "node",
    // A process per test FILE, pinned rather than inherited.
    //
    // The database tests point the connection pool at a private schema by
    // rewriting DATABASE_URL, and the pool is a module singleton. That is safe
    // exactly as long as two test files never share a module registry — which
    // is true of `forks` and false of `threads`. Leaving it to the default means
    // a vitest upgrade could change the isolation model underneath a suite whose
    // correctness depends on it, and the symptom would be a rare cross-file
    // flake rather than a clean failure.
    pool: "forks",
    /**
     * Long enough for a REMOTE database.
     *
     * The default is 10 seconds, which is ample against a local server and not
     * against a managed one. Every database suite's `beforeAll` creates a
     * private schema and migrates into it, and `migrate()` takes a
     * database-wide advisory lock — so five files running in parallel serialise
     * there. At ~90ms per round trip to a managed instance that is comfortably
     * past ten seconds, and the failure arrives as "Hook timed out", which
     * reads like a hang rather than like latency.
     *
     * The suites are designed for a local or CI database; this only makes
     * pointing them at a managed one survivable rather than fast.
     */
    hookTimeout: 60_000,
    testTimeout: 30_000,
    server: {
      deps: {
        // Let vite transform the bot kit and the venue SDK rather than letting
        // Node resolve them.
        //
        // `ec-core` ships raw TypeScript, and `markets-sdk`'s dist uses
        // extensionless relative imports — legal for a bundler, unresolvable by
        // Node's ESM loader. `tsx` handles both, which is why every CLI works;
        // vitest externalises node_modules by default and hands them to Node,
        // which does not. Only executor.kit.test.ts reaches this code, and only
        // when the kit is installed.
        inline: [/@dreamdex-bot-kit/, /@somnia-chain[\\/]markets-sdk/],
      },
    },
  },
});
