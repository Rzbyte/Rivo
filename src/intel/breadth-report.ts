// One assembly of the breadth study, for both surfaces that publish it.
//
// `npm run breadth` writes a dated artefact and `/api/breadth` serves the live
// figure, and those two must not be able to disagree about anything except when
// they were computed. This repository has already paid for that lesson twice —
// README §7 against final-proof.json, and a test count that drifted in the one
// document nothing guarded — so the shape is built once, here, and both callers
// render what they are given.
//
// The statistics live in `breadth.ts` and stay pure. This is the part that needs
// a database.

import { query } from "../db/pool.js";
import { BASELINES } from "./baselines.js";
import { MIN_WINDOWS, summarise, verdict, type BreadthStat, type Entry } from "./breadth.js";

export interface BreadthStrategy extends BreadthStat {
  slug: string;
  label: string;
  kind: string;
  state: string;
  /** The hypothesis this strategy is on the study to test. Null for agents that are not baselines. */
  question: string | null;
  isBaseline: boolean;
  /** Every decision ever put to it, including the ones it declined. */
  asked: number;
  settled: number;
  verdict: ReturnType<typeof verdict>;
}

export interface BreadthReport {
  generatedAt: string;
  question: string;
  about: string;
  method: Record<string, unknown>;
  hypothetical: true;
  strategies: BreadthStrategy[];
  provenance: Record<string, unknown>;
}

interface AgentRow {
  id: string;
  slug: string;
  label: string;
  state: string;
  kind: string;
  summary: { question?: string; baseline?: boolean } | null;
}

export async function breadthReport(): Promise<BreadthReport> {
  const agents = await query<AgentRow>(
    `SELECT id::text, slug, label, state, kind, summary FROM agents ORDER BY created_at`,
  );

  const strategies: BreadthStrategy[] = [];
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

    strategies.push({
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

  return {
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
      baselines: BASELINES.map((b) => ({ slug: b.slug, question: b.question })),
    },
    hypothetical: true,
    strategies,
    provenance: {
      producedBy: "npm run breadth, and /api/breadth from the same function",
      source: "the shadow_decisions table, resolved against venue settlement",
      verifiable: [
        "no row here corresponds to a transaction — the shadow path cannot reach a signer",
        "every baseline is reached over its public HTTP endpoint, the same path a stranger's agent takes",
        "the baselines' rules are in src/intel/baselines.ts and each endpoint serves its own rule on GET",
      ],
    },
  };
}
