// Every measured result, in one payload, with no database and no wallet.
//
// This is deliberately the most robust surface in the product. The other pages
// need PostgreSQL to say anything; this one needs a filesystem, so it keeps
// answering when the database is asleep, unreachable, or has never been
// provisioned — which is exactly the moment somebody is deciding whether this
// project is real.

import { NextResponse } from "next/server";
import { artefact } from "@/lib/evidence";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return NextResponse.json({
    canary: artefact("canary-fresh"),
    calibration: artefact("calibration"),
    backtest: artefact("backtest"),
    maker: artefact("maker-live"),
    coherence: artefact("coherence"),
  });
}
