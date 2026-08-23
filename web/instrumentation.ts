// Load the repository's `.env` once, before any route runs.
//
// Next.js loads its own `.env` from the app directory. Rivo's lives at the
// repository root, one level up, because the worker and the CLI read the same
// file — there is one deployment's worth of configuration and it should exist
// in one place.
//
// Without this the app reported "no DATABASE_URL configured" on a machine whose
// `.env` had one, and nothing anywhere pointed at the reason: `loadEnv` searched
// only `process.cwd()`, and Next's cwd is `web/`.
//
// `register()` runs once at server start, before the first request, so every
// route inherits it without importing anything.
//
// On Vercel this is a no-op: there is no `.env` in a deployment, and platform
// environment variables are already in `process.env`. `loadEnv` never overwrites
// a variable that is already set, so the two cannot fight.

export async function register(): Promise<void> {
  const { loadEnv, findEnvFile } = await import("@rivo/core/env.js");
  loadEnv();
  const path = findEnvFile();
  console.log(path ? `[rivo] loaded ${path}` : "[rivo] no .env found — using the platform environment");
}
