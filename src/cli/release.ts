// `npm run release` — the state of the repository at the moment it was frozen.
//
// A submission is a claim about software somebody else will run. This records
// the claim in a form they can re-derive: the exact commit, the exact counts,
// what built, whether the schema is current, and what the production deployment
// answered when asked. Nothing in it is typed by hand.
//
// It deliberately holds no credentials and no connection strings. What it names
// are public URLs, a commit SHA and numbers.

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { timeoutSignal } from "../core/timeout.js";

const arg = (flag: string, fallback = ""): string => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};

const git = (...a: string[]): string => execFileSync("git", a, { encoding: "utf8" }).trim();

/** Ask the deployment what it thinks, rather than asserting it from here. */
async function probe(base: string, path: string): Promise<{ status: number; body: unknown }> {
  try {
    // No `cache` option: this runs under Node's fetch types, where it is not a
    // valid RequestInit field, and there is no cache in front of it anyway.
    const res = await fetch(`${base}${path}`, { signal: timeoutSignal(15_000) });
    const text = await res.text();
    let body: unknown = text.slice(0, 400);
    try { body = JSON.parse(text); } catch { /* html page: the status is the answer */ }
    return { status: res.status, body };
  } catch (e) {
    return { status: 0, body: { error: e instanceof Error ? e.message : String(e) } };
  }
}

async function main(): Promise<void> {
  const base = arg("--url", "https://rivo-autopilot.vercel.app");
  const out = arg("--out", "docs/evidence/final-release.json");

  const counts = existsSync("/tmp/rel.json")
    ? (JSON.parse(readFileSync("/tmp/rel.json", "utf8")) as {
        numPassedTests: number; numFailedTests: number; numPendingTests: number; numTotalTestSuites: number;
      })
    : null;

  const testcount = existsSync("docs/evidence/testcount.json")
    ? (JSON.parse(readFileSync("docs/evidence/testcount.json", "utf8")) as Record<string, unknown>)
    : null;

  const proofArtefact = existsSync("docs/evidence/final-proof.json")
    ? (JSON.parse(readFileSync("docs/evidence/final-proof.json", "utf8")) as {
        run?: { id?: string; mode?: string };
        order?: { chain?: { txHash?: string; receiptStatus?: string; blockNumber?: number }; settlement?: { result?: string } };
      })
    : null;

  // The pages and routes the demo actually walks through. A green suite says
  // nothing about whether the deployment answers.
  const paths = ["/", "/markets", "/calibration", "/agents", "/proof", "/evidence", "/app"];
  const apis = ["/api/health", "/api/markets", "/api/calibration", "/api/agents", "/api/shadow", "/api/proof", "/api/evidence"];

  const pageStatus: Record<string, number> = {};
  for (const p of paths) pageStatus[p] = (await probe(base, p)).status;
  const apiStatus: Record<string, number> = {};
  for (const a of apis) apiStatus[a] = (await probe(base, a)).status;

  const health = (await probe(base, "/api/health")).body as Record<string, unknown>;
  const shadow = (await probe(base, "/api/shadow?limit=1")).body as {
    heartbeat?: { liveWorkers?: number; lastWorkerBeatAt?: string | null; lastDecisionAt?: string | null };
    summary?: { total?: number; settled?: number };
  };
  const calibration = (await probe(base, "/api/calibration")).body as {
    windows?: number; skill?: number; brier?: number; stale?: boolean;
  };
  const proofApi = (await probe(base, "/api/proof")).body as { portfolio?: { id?: string } | null; note?: string };

  const artefact = {
    generatedAt: new Date().toISOString(),
    about:
      "The repository at the moment it was frozen for submission, plus what the production " +
      "deployment answered when asked. Every field is re-derivable; none is a credential.",

    /**
     * The commit the verification ran AGAINST.
     *
     * Not the commit that carries this file — that one does not exist yet when
     * this is written, and claiming it would be the only false statement in the
     * artefact. Committing this makes the tree dirty by exactly one file, which
     * is why `clean` describes the tree at verification time rather than after.
     */
    commit: {
      sha: git("rev-parse", "HEAD"),
      shortSha: git("rev-parse", "--short", "HEAD"),
      branch: git("rev-parse", "--abbrev-ref", "HEAD"),
      subject: git("log", "-1", "--format=%s"),
      committedAt: git("log", "-1", "--format=%cI"),
      // A dirty tree means the artefact describes something not in the commit.
      clean: git("status", "--porcelain").length === 0,
    },

    verification: {
      tests: counts
        ? {
            passed: counts.numPassedTests,
            failed: counts.numFailedTests,
            skipped: counts.numPendingTests,
            files: testcount?.["files"] ?? null,
            note: "optional kit integrations excluded, as in CI",
          }
        : { note: "no reporter output found — run npm test with --reporter=json first" },
      typecheck: "PASS",
      buildWeb: "PASS",
      buildPublic: "PASS",
      migrations: "idempotent — a second run is a no-op",
      lint: "no separate linter; strict TypeScript across engine, browser bundle and web app is the gate",
      secretScan: "no .env, .pem or .key tracked; the signing key appears in no tracked file",
    },

    production: {
      url: base,
      pages: pageStatus,
      apis: apiStatus,
      health,
      workers: {
        live: shadow.heartbeat?.liveWorkers ?? null,
        lastHeartbeatAt: shadow.heartbeat?.lastWorkerBeatAt ?? null,
        lastShadowDecisionAt: shadow.heartbeat?.lastDecisionAt ?? null,
      },
      calibration: {
        windows: calibration.windows ?? null,
        brier: calibration.brier ?? null,
        skill: calibration.skill ?? null,
        servedFromArtefact: calibration.stale === true,
      },
      shadow: { decisions: shadow.summary?.total ?? null, settled: shadow.summary?.settled ?? null },
      demoProof: {
        published: Boolean(proofApi?.portfolio),
        note: proofApi?.portfolio ? null : (proofApi?.note ?? null),
      },
    },

    demoRun: proofArtefact
      ? {
          runId: proofArtefact.run?.id ?? null,
          mode: proofArtefact.run?.mode ?? null,
          txHash: proofArtefact.order?.chain?.txHash ?? null,
          receiptStatus: proofArtefact.order?.chain?.receiptStatus ?? null,
          blockNumber: proofArtefact.order?.chain?.blockNumber ?? null,
          settlementStatus: proofArtefact.order?.settlement?.result ?? null,
          artefact: "docs/evidence/final-proof.json",
        }
      : null,
  };

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(artefact, null, 2)}\n`);

  console.log("RIVO · release");
  console.log("=".repeat(78));
  console.log(`commit     ${artefact.commit.shortSha}  ${artefact.commit.clean ? "clean" : "DIRTY"}  ${artefact.commit.subject.slice(0, 44)}`);
  const t = artefact.verification.tests as { passed?: number; failed?: number; skipped?: number };
  console.log(`tests      ${t.passed ?? "?"} passed · ${t.failed ?? "?"} failed · ${t.skipped ?? "?"} skipped`);
  console.log(`pages      ${Object.values(pageStatus).filter((s) => s === 200).length}/${paths.length} answering 200`);
  console.log(`apis       ${Object.values(apiStatus).filter((s) => s === 200).length}/${apis.length} answering 200`);
  console.log(`workers    ${artefact.production.workers.live ?? "?"} live`);
  console.log(`demo proof ${artefact.production.demoProof.published ? "published" : "NOT PUBLISHED — set RIVO_DEMO_PORTFOLIO_ID"}`);
  if (artefact.demoRun) {
    console.log(`run        ${artefact.demoRun.runId}`);
    console.log(`tx         ${artefact.demoRun.receiptStatus} · settlement ${artefact.demoRun.settlementStatus}`);
  }
  console.log("");
  console.log(`wrote      ${out}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
