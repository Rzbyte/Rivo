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
  },
});
