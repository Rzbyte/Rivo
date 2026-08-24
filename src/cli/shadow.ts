// `npm run shadow -- [--once] [--interval 60] [--agent rivo-v1]`
//
// Runs registered agents against live DreamDEX Event Contracts and records what
// they WOULD have done. Nothing here can move capital: there is no signer in
// this process and no executor is constructed.
//
// It also resolves what has already settled, which is the half that makes the
// product a loop rather than a log — a decision without an outcome is a claim,
// and an outcome written back is evidence.

import { Indexer } from "../core/indexer.js";
import { snapshot } from "../engine/scan.js";
import { query, closeDb } from "../db/pool.js";
import { askAgent, referenceAgent, type EventContext } from "../intel/agent.js";
import { recordShadow, pendingShadow, resolveShadow, payout, hypotheticalPnl } from "../intel/shadow.js";
import type { Leg } from "../engine/book.js";

const arg = (f: string, d?: string): string | undefined => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : d;
};
const has = (f: string): boolean => process.argv.includes(f);

interface AgentRow { id: string; slug: string; label: string; kind: string; endpoint: string | null; state: string }

/** Collateral one agent may ask for on one leg. Rivo's number, not theirs. */
const MAX_NOTIONAL = Number(arg("--max-notional", "5"));

async function decideOnce(idx: Indexer, agents: AgentRow[], out: (s: string) => void): Promise<number> {
  const snap = await snapshot(idx);
  const rivo = referenceAgent();
  let recorded = 0;

  for (const a of agents) {
    for (const o of snap.opportunities) {
      if (o.blocked && !o.blocked.startsWith("edge")) continue; // nothing to decide about
      const ctx: EventContext = {
        market: {
          marketId: o.marketId, asset: o.asset, leg: o.leg as Leg,
          intervalSec: o.intervalSec, expiry: o.expiry,
          secondsLeft: Math.max(0, o.expiry - snap.at),
        },
        price: { bid: o.bid, ask: o.ask, depth: o.depthAtFair },
        reference: {
          spot: snap.assets.get(o.asset)?.spot ?? null,
          probability: Number.isFinite(o.fair) ? o.fair : null,
        },
        limits: { maxNotional: MAX_NOTIONAL },
      };

      const d = a.kind === "http" && a.endpoint ? await askAgent(a.endpoint, ctx) : rivo(ctx);

      await recordShadow({
        agentId: a.id,
        marketId: o.marketId, asset: o.asset, leg: o.leg as Leg,
        intervalSec: o.intervalSec, expiry: o.expiry,
        marketPrice: o.ask ?? o.mid ?? 0,
        agentPrice: d.probability,
        confidence: d.confidence,
        action: d.action,
        reason: d.reason,
        // Recorded only for an ENTER. A SKIP has no trade to price, and writing
        // zero would make it look like one that lost nothing.
        hypotheticalSize: d.action === "ENTER" ? d.notional : null,
        hypotheticalEntry: d.action === "ENTER" ? o.ask : null,
      });
      recorded++;
    }
    out(`  ${a.slug.padEnd(14)} ${snap.opportunities.length} legs considered`);
  }
  return recorded;
}

/** Write settled outcomes back onto shadow rows. */
async function resolve(idx: Indexer, out: (s: string) => void): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const pending = await pendingShadow(now);
  if (pending.length === 0) return 0;

  const ids = [...new Set(pending.map((p) => p.marketId))];
  const outcomes = await idx.outcomes(ids);
  let done = 0;

  for (const p of pending) {
    const o = outcomes.get(p.marketId.toLowerCase()) ?? outcomes.get(p.marketId);
    if (!o || !o.finalized) continue; // expiry is not finalisation
    const settled = payout(p.leg, o.winningOutcome, o.voided);
    if (settled === null) continue; // voided: no outcome to record
    if (await resolveShadow(p.id, settled, hypotheticalPnl(settled, p.hypotheticalEntry, p.hypotheticalSize))) done++;
  }
  if (done > 0) out(`  resolved ${done} shadow decision(s) against settled outcomes`);
  return done;
}

async function main(): Promise<void> {
  const only = arg("--agent");
  const intervalSec = Number(arg("--interval", "60"));
  const out = (s: string) => console.log(s);

  const agents = await query<AgentRow>(
    `SELECT id, slug, label, kind, endpoint, state FROM agents
      WHERE ($1::text IS NULL OR slug = $1) ORDER BY created_at`,
    [only ?? null],
  );
  if (agents.length === 0) {
    console.error(only ? `no agent with slug ${only}` : "no agents registered");
    process.exitCode = 1;
    await closeDb();
    return;
  }

  console.log("RIVO SHADOW  ·  decisions only, no capital can move from this process");
  console.log("=".repeat(78));
  for (const a of agents) console.log(`  ${a.slug.padEnd(14)} ${a.label}  [${a.state}]${a.kind === "http" ? "  http" : ""}`);
  console.log(`  max notional per leg  ${MAX_NOTIONAL}`);
  console.log("");

  const idx = new Indexer();
  let pass = 0;
  for (;;) {
    pass++;
    const at = new Date().toISOString().slice(11, 19);
    try {
      const n = await decideOnce(idx, agents, out);
      const r = await resolve(idx, out);
      console.log(`[${at}] pass ${pass}: ${n} decision(s) recorded, ${r} settled`);
    } catch (e) {
      // One bad pass must not end the run. The venue is somebody else's service.
      console.log(`[${at}] pass ${pass} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (has("--once")) break;
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
  }
  await closeDb();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
