// Portfolios: list, and create.

import { NextResponse } from "next/server";
import { badRequest, withUser } from "@/lib/auth";
import { amount, isProfile, jsonBody } from "@/lib/validate";
import { createPortfolio, portfoliosOf } from "@rivo/db/portfolios.js";
import { walletsOf } from "@rivo/db/accounts.js";
import { network } from "@rivo/core/config.js";
import type { ProfileName } from "@rivo/portfolio/profiles.js";

export const dynamic = "force-dynamic";

export const GET = withUser(async (user) => {
  const portfolios = await portfoliosOf(user.id);
  return NextResponse.json({
    portfolios: portfolios.map((p) => ({
      id: p.id,
      address: p.address,
      network: p.network,
      capital: p.policy.capital,
      profile: p.policy.profile,
      mode: p.policy.mode,
      state: p.policy.state,
      delegated: p.delegated,
    })),
  });
});

/**
 * Create a portfolio against the user's Rivo wallet.
 *
 * It starts in Shadow Mode and `idle`, always — never running, never trading.
 * Enabling Autopilot is a separate, explicit act with its own consent step, and
 * collapsing the two into "create" would mean a POST that begins spending money.
 */
export const POST = withUser(async (user, req) => {
  const body = await jsonBody(req);
  const capital = amount(body.capital, "capital");
  if (capital <= 0) badRequest("capital must be greater than zero");
  const profile = body.profile ?? "balanced";
  if (!isProfile(profile)) badRequest(`profile must be conservative, balanced or active`);
  const chosen = profile as ProfileName;

  const wallets = await walletsOf(user.id);
  const portfolioWallet = wallets.find((w) => w.kind === "portfolio");
  if (!portfolioWallet) {
    badRequest("no Rivo wallet is registered for this account yet");
  }

  const existing = await portfoliosOf(user.id);
  // One portfolio per user, for now, and said out loud rather than enforced by a
  // constraint nobody can find. The engine is per-portfolio throughout and would
  // support several; the product has nothing yet that would let a user tell them
  // apart, and an unnameable second portfolio is a support ticket.
  if (existing.length > 0) {
    return NextResponse.json({ portfolio: shape(existing[0]!) });
  }

  const created = await createPortfolio({
    userId: user.id,
    walletId: portfolioWallet!.id,
    network: network(),
    capital,
    profile: chosen,
    mode: "shadow",
  });
  return NextResponse.json({ portfolio: shape(created) }, { status: 201 });
});

const shape = (p: Awaited<ReturnType<typeof createPortfolio>>) => ({
  id: p.id,
  address: p.address,
  network: p.network,
  capital: p.policy.capital,
  profile: p.policy.profile,
  mode: p.policy.mode,
  state: p.policy.state,
  delegated: p.delegated,
});
