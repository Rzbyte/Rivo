import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // These tests are pure: no network, no clock, no filesystem beyond a temp dir.
    // Anything that needs the venue belongs in the CLIs, which are exercised by
    // running them against it — a unit test that depends on a live order book
    // fails for reasons that have nothing to do with the code under test.
    environment: "node",
  },
});
