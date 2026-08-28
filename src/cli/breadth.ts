// `npm run breadth` — does anything simple clear the spread on Event Contracts?
//
// Reads the shadow ledger, groups every registered agent's settled decisions by
// the contract they were made inside, and writes `docs/evidence/strategy-breadth.json`.
//
// Every row here is HYPOTHETICAL. Not one of these decisions moved capital: the
// columns are named `hypothetical_*` precisely so a query has to opt into the
// lie, and this one opts in on purpose and says so in the artefact.
//
//   npm run breadth                    # write the artefact
//   npm run breadth -- --dry           # print it, write nothing

import { writeFileSync } from "node:fs";
import { loadEnv } from "../core/env.js";
import { closeDb, configured, query, safeTarget } from "../db/pool.js";
import { MIN_WINDOWS, summarise, verdict, type Entry } from "../intel/breadth.js";
import { BASELINES } from "../intel/baselines.js";

const OUT = "docs/evidence/strategy-breadth.json";

interface AgentRow {
  id: string;
  slug: string;
  label: string;
  state: string;
  kind: string;
  summary: { question?: string; baseline?: boolean } | null;
}

const pct = (v: number | null): string => (v === null ? "     —" : `${(v * 100 >= 0 ? "+" : "")}${(v * 100).toFixed(2)}%`);

async function main(): Promise<void> {
  loadEnv();
  if (!configured()) {
    console.error("DATABASE_URL is not set. The shadow ledger lives in Postgres.");
    process.exitCode = 1;
    return;
  }

  const agents = await query<AgentRow>(
    `SELECT id::text, slug, label, state, kind, summary FROM agents ORDER BY created_at`,
  );
  if (agents.length === 0) {
    console.error("No agents registered. Try: npm run seed:agents");
    process.exitCode = 1;
    await closeDb();
    return;
  }

  const rows = [];
  for (const a of agents) {
    // Settled AND sized. A decision the agent declined to size has an outcome
    // but no stake, so it belongs in `asked` and nowhere near a return.
    const entries = await query<{ market_id: string; stake: string; pnl: string; won: number }>(
      `SELECT market_id,
              (hypothetical_entry * hypothetical_size)::text AS stake,
              hypothetical_pnl::text                         AS pnl,
              outcome                                        AS won
         FROM shadow_decisions
        WHERE agent_id = $1
          AND settled_at IS NOT NULL
          AND hypothetical_entry IS NOT NULL
          AND hypothetical_size IS NOT NULL
          AND hypothetical_pnl IS NOT NULL`,
      [a.id],
    );
    const [counts] = await query<{ asked: string; settled: string }>(
      `SELECT count(*)::text                                       AS asked,
              count(*) FILTER (WHERE settled_at IS NOT NULL)::text AS settled
         FROM shadow_decisions WHERE agent_id = $1`,
      [a.id],
    );

    const stat = summarise(
      entries.map((e): Entry => ({
        marketId: e.market_id,
        stake: Number(e.stake),
        pnl: Number(e.pnl),
        won: e.won === 1 ? 1 : 0,
      })),
    );

    rows.push({
      slug: a.slug,
      label: a.label,
      kind: a.kind,
      state: a.state,
      question: a.summary?.question ?? null,
      isBaseline: a.summary?.baseline === true,
      asked: Number(counts?.asked ?? 0),
      settled: Number(counts?.settled ?? 0),
      ...stat,
      verdict: verdict(stat),
    });
  }

  const artefact = {
    generatedAt: new Date().toISOString(),
    question: "Does any simple strategy clear the spread on DreamDEX Event Contracts?",
    about:
      "Every registered agent's shadow record, aggregated. Each row is a strategy that decided " +
      "against live Event Contracts and never sent anything; every outcome was resolved against " +
      "the venue's own settlement. This is a distribution, not a ranking — there is no score and " +
      "no winner, and `coin-flip` is on it as the null hypothesis.",
    method: {
      unit: "window",
      note:
        "The point estimate pools decisions; the interval is bootstrapped over settled CONTRACTS, " +
        "not rows. Decisions inside one contract share one outcome, so treating them as " +
        "independent observations reports a precision nobody has.",
      returnOnStake: "sum(hypothetical_pnl) / sum(hypothetical_entry * hypothetical_size)",
      bootstrap: 400,
      seed: 17,
      minWindows: MIN_WINDOWS,
      verdicts:
        "CLEARS_THE_SPREAD when the 95% interval is entirely above zero, LOSES when entirely " +
        "below, INCONCLUSIVE when it straddles zero, and null when the row is too thin to say.",
    },
    hypothetical: true,
    baselines: BASELINES.map((b) => ({ slug: b.slug, question: b.question })),
    strategies: rows,
    provenance: {
      producedBy: "npm run breadth",
      source: "the shadow_decisions table, resolved against venue settlement",
      verifiable: [
        "no row here corresponds to a transaction — the shadow path cannot reach a signer",
        "every baseline is reached over its public HTTP endpoint, the same path a stranger's agent takes",
        "the baselines' rules are in src/intel/baselines.ts and each endpoint serves its own rule on GET",
      ],
    },
  };

  console.log(`database   ${safeTarget()}`);
  console.log("");
  console.log("strategy          state         asked  settled  windows   return    95% interval      verdict");
  console.log("─".repeat(100));
  for (const r of rows) {
    const iv = r.lo95 === null ? "        —        " : `${pct(r.lo95)} … ${pct(r.hi95)}`;
    console.log(
      `${r.slug.padEnd(17)} ${r.state.padEnd(12)} ${String(r.asked).padStart(6)} ${String(r.settled).padStart(8)} ` +
        `${String(r.windows).padStart(8)}  ${pct(r.returnOnStake)}  ${iv}  ${r.verdict ?? (r.thin ? "thin" : "—")}`,
    );
  }
  console.log("");

  if (process.argv.includes("--dry")) {
    console.log("--dry: nothing written.");
  } else {
    writeFileSync(OUT, `${JSON.stringify(artefact, null, 2)}\n`);
    console.log(`wrote ${OUT}`);
  }
  await closeDb();
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.message : String(e));
  await closeDb().catch(() => undefined);
  process.exitCode = 1;
});
