// `npm run db:migrate` — bring a database up to date, and say what it did.
import { migrate } from "../db/migrate.js";
import { closeDb, configured, safeTarget } from "../db/pool.js";
import { loadEnv } from "../core/env.js";

async function main(): Promise<void> {
  loadEnv();
  if (!configured()) {
    console.error("DATABASE_URL is not set. Nothing to migrate.");
    console.error("Rivo's CLI, backtester and tests do not need one — only the web app and the worker do.");
    process.exitCode = 1;
    return;
  }
  console.log(`migrating ${safeTarget()}`);
  const res = await migrate();
  for (const n of res.alreadyApplied) console.log(`  ok      ${n}`);
  for (const n of res.applied) console.log(`  APPLIED ${n}`);
  console.log(res.applied.length === 0 ? "\nalready up to date." : `\n${res.applied.length} migration(s) applied.`);
  await closeDb();
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.message : String(e));
  await closeDb().catch(() => undefined);
  process.exitCode = 1;
});
