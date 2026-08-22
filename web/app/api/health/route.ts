// Is this deployment working?
//
// Public and unauthenticated on purpose — a health check that needs a session is
// one an uptime monitor cannot use. It says nothing a stranger should not know:
// no host, no credential, no user count. Whether a database answers, whether the
// schema is current, and whether any worker is alive.

import { NextResponse } from "next/server";
import { configured } from "@rivo/db/pool.js";
import { pending } from "@rivo/db/migrate.js";
import { liveWorkers } from "@rivo/db/leases.js";
import { privyConfigured } from "@rivo/signing/privy.js";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const base = {
    ok: false,
    database: configured(),
    privy: privyConfigured(),
    // The web app CHECKS the schema; the worker migrates it. Exactly one
    // component may alter a schema, or a deploy that starts both races itself.
    schemaCurrent: false as boolean | null,
    workers: 0,
    // A deployment with a database and no worker is a real and confusing state:
    // the app works, the portfolios sit still, and nothing says why.
    note: "" as string,
  };
  if (!configured()) {
    return NextResponse.json({ ...base, schemaCurrent: null, note: "no DATABASE_URL configured" }, { status: 503 });
  }
  try {
    const outstanding = await pending();
    const fleet = await liveWorkers();
    const ok = outstanding.length === 0;
    return NextResponse.json(
      {
        ...base,
        ok,
        schemaCurrent: ok,
        workers: fleet.length,
        note: !ok
          ? `${outstanding.length} migration(s) pending — start the worker, which migrates on boot`
          : fleet.length === 0
            ? "no worker is running: portfolios will not trade until one is started"
            : "",
      },
      { status: ok ? 200 : 503 },
    );
  } catch (e) {
    console.error("health check failed:", e);
    return NextResponse.json({ ...base, note: "the database did not answer" }, { status: 503 });
  }
}
