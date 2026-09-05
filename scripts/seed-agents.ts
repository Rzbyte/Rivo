// Register the six baseline strategies, so the breadth study has subjects.
//
//   npx tsx scripts/seed-agents.ts --base https://x-rivo.vercel.app
//   npx tsx scripts/seed-agents.ts --base http://localhost:3000 --allow-private
//
// They are registered as `kind: 'http'` against their PUBLIC URLs, not as
// `builtin`, and this script deliberately puts them through the same two gates
// a stranger's agent passes on `POST /api/agents`: `verifyEndpointUrl` and a
// live probe. A seeder that inserted rows directly would be able to register an
// agent the product itself would refuse, and the study would then be measuring
// subjects the platform cannot actually host.
//
// Idempotent on `slug`. Re-running after a redeploy updates the endpoint and
// leaves the accumulated shadow decisions — which are keyed on `agent_id` —
// exactly where they are.
//
// They are seeded UNVALIDATED, which is the truth: none of them has passed
// economic validation, and none of them may spend. `owner_user` is NULL because
// nobody owns them; they are Rivo's published reference set.

import { loadEnv } from "../src/core/env.js";
import { closeDb, configured, query, safeTarget } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import { BASELINES } from "../src/intel/baselines.js";
import { askAgent, type EventContext } from "../src/intel/agent.js";
import { verifyEndpointUrl } from "../src/intel/endpoint.js";

const arg = (flag: string, fallback: string): string => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};

/**
 * The question each baseline is asked once, before it is stored.
 *
 * Live-shaped, with a market id that settles nothing and a phase late enough
 * that `late-entry` has something to say — a probe every baseline SKIPs would
 * be a probe that cannot tell "declined" from "broken".
 */
const PROBE: EventContext = {
  market: {
    marketId: "0x" + "00".repeat(32),
    asset: "BTC",
    leg: "UP",
    intervalSec: 900,
    expiry: Math.floor(Date.now() / 1000) + 60,
    secondsLeft: 60,
  },
  price: { bid: 0.6, ask: 0.62, depth: 100 },
  reference: { spot: 77_000, probability: 0.75 },
  limits: { maxNotional: 5 },
};

async function main(): Promise<void> {
  loadEnv();
  if (!configured()) {
    console.error("DATABASE_URL is not set. Try: npx tsx scripts/dev-postgres.ts start");
    process.exitCode = 1;
    return;
  }

  const base = arg("--base", process.env.RIVO_PUBLIC_URL ?? "https://x-rivo.vercel.app").replace(/\/$/, "");
  const allowPrivate = process.argv.includes("--allow-private");

  await migrate();
  console.log(`database   ${safeTarget()}`);
  console.log(`base       ${base}`);
  console.log("");

  let registered = 0;
  let refused = 0;

  for (const b of BASELINES) {
    const endpoint = `${base}/api/reference-agents/${b.slug}`;

    const verdict = await verifyEndpointUrl(endpoint, { allowPrivate });
    if (!verdict.ok) {
      console.log(`  REFUSED  ${b.slug} — ${verdict.reason ?? "endpoint did not pass vetting"}`);
      refused++;
      continue;
    }

    // Probe before saving, exactly as the connect form does. An endpoint that
    // cannot answer is not registered, however good the code behind it looks.
    const probe = await askAgent(endpoint, PROBE, { timeoutMs: 10_000 });
    if (probe.reason && /unreachable|in time|HTTP \d|redirect|did not return/i.test(probe.reason)) {
      console.log(`  UNREACHABLE  ${b.slug} — ${probe.reason}`);
      console.log(`               is ${base} deployed with this route?`);
      refused++;
      continue;
    }

    await query(
      `INSERT INTO agents (slug, label, kind, endpoint, auth_header, owner_user, state, evidence, summary)
       VALUES ($1, $2, 'http', $3, NULL, NULL, 'UNVALIDATED', $4, $5)
       ON CONFLICT (slug) DO UPDATE
         SET label = EXCLUDED.label,
             endpoint = EXCLUDED.endpoint,
             evidence = EXCLUDED.evidence,
             summary = EXCLUDED.summary,
             updated_at = now()`,
      [
        b.slug,
        b.label,
        endpoint,
        "docs/EVIDENCE.md",
        JSON.stringify({
          baseline: true,
          question: b.question,
          source: "src/intel/baselines.ts",
          seededAt: new Date().toISOString(),
          probe: { action: probe.action, reason: probe.reason },
        }),
      ],
    );
    console.log(`  ok       ${b.slug.padEnd(16)} ${probe.action.padEnd(5)}  ${b.question}`);
    registered++;
  }

  console.log("");
  console.log(`${registered} registered, ${refused} refused.`);
  if (registered > 0) {
    console.log("");
    console.log("The worker shadow-runs every row in `agents`, so decisions start accruing");
    console.log("on its next pass. Nothing here can spend: all six are UNVALIDATED and have");
    console.log("no signer, and the pre-execution pipeline is the only route to one.");
    console.log("");
    console.log("  npm run breadth        # once enough of them have settled");
  }
  await closeDb();
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.message : String(e));
  await closeDb().catch(() => undefined);
  process.exitCode = 1;
});
