// A portfolio to look at, without signing in.
//
// The product's onboarding runs through Privy, which needs credentials a
// reviewer will not have. This creates the same rows that flow would create —
// a user, a portfolio wallet, a portfolio, its runtime row and its lease — so
// the worker has something to manage and the dashboard has something to show.
//
// It creates a SHADOW portfolio and cannot create anything else: the wallet has
// no Privy wallet id and is not delegated, so `mayTradeLive` is false and the
// worker will run it dry no matter what the flags say. A demo seeder that could
// arm live trading would be a demo seeder that eventually does.
//
//   npx tsx scripts/seed-demo.ts --capital 50 --profile balanced

import { loadEnv } from "../src/core/env.js";
import { closeDb, configured, query, safeTarget } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import { upsertUser, upsertWallet } from "../src/db/accounts.js";
import { createPortfolio, portfoliosOf, setState } from "../src/db/portfolios.js";
import { network } from "../src/core/config.js";
import { profile as resolveProfile } from "../src/portfolio/profiles.js";

const arg = (flag: string, fallback: string): string => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};

/**
 * A deterministic address, so re-running the seeder reuses one demo portfolio.
 *
 * Hex only: `parsePolicy` validates the owner as a real address and is right to,
 * so a memorable-looking placeholder is not an option. Nobody holds the key to
 * this one, which is exactly what a demo wants.
 */
const DEMO_ADDRESS = "0xde0000000000000000000000000000000000de00";
const DEMO_DID = "did:privy:rivo-demo";

async function main(): Promise<void> {
  loadEnv();
  if (!configured()) {
    console.error("DATABASE_URL is not set. Try: npx tsx scripts/dev-postgres.ts start");
    process.exitCode = 1;
    return;
  }
  const capital = Number(arg("--capital", "50"));
  const prof = resolveProfile(arg("--profile", "balanced"));

  await migrate();
  const user = await upsertUser(DEMO_DID, "demo@rivo.local");
  const wallet = await upsertWallet({ userId: user.id, address: DEMO_ADDRESS, kind: "portfolio" });

  const existing = await portfoliosOf(user.id);
  const portfolio =
    existing[0] ??
    (await createPortfolio({
      userId: user.id,
      walletId: wallet.id,
      network: network(),
      capital,
      profile: prof.name as "conservative" | "balanced" | "active",
      mode: "shadow",
    }));

  // Running, so the scheduler picks it up. Shadow, because the wallet has no way
  // to sign — which the worker checks for itself rather than trusting this.
  await setState(user.id, portfolio.id, "running", null);
  await query("UPDATE portfolios SET capital = $2, next_run_at = now() WHERE id = $1", [portfolio.id, capital]);
  await query("UPDATE portfolio_runtime SET cash = $2, peak_equity = $2 WHERE portfolio_id = $1 AND cycles = 0", [
    portfolio.id,
    capital,
  ]);

  console.log(`database   ${safeTarget()}`);
  console.log(`portfolio  ${portfolio.id}`);
  console.log(`wallet     ${DEMO_ADDRESS}  (no signer — Shadow Mode, enforced)`);
  console.log(`capital    ${capital}   profile ${prof.name}   network ${network()}`);
  console.log("");
  console.log("Now run the worker:");
  console.log("  npm run worker -- --once        # one pass");
  console.log("  npm run worker                  # keep going");
  await closeDb();
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.message : String(e));
  await closeDb().catch(() => undefined);
  process.exitCode = 1;
});
