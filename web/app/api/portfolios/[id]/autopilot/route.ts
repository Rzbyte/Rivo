// The switch.
//
// Turning Autopilot ON is the single most consequential action in the product,
// and it is deliberately NOT what grants Rivo the authority to sign. That
// happens in the browser, through Privy, with the user's own consent prompt —
// this endpoint only records the result and starts the portfolio.
//
// The order matters and is enforced here: Rivo refuses to start a portfolio in
// autopilot whose wallet is not delegated. If the consent step was skipped,
// declined, or silently failed, the answer is a refusal that says so — not a
// portfolio that appears to be running and quietly cannot trade.
//
// Turning it OFF is different in kind, and the difference is the whole safety
// story: stopping takes effect here, immediately, and does not depend on the
// browser succeeding at anything.

import { NextResponse } from "next/server";
import { badRequest, notFound, withUser } from "@/lib/auth";
import { jsonBody } from "@/lib/validate";
import { portfolioOf, setState, updatePolicy } from "@rivo/db/portfolios.js";
import { setDelegated, upsertWallet } from "@rivo/db/accounts.js";
import { record } from "@rivo/db/events.js";
import { buildView } from "@rivo/db/view.js";
import { privyConfigured } from "@rivo/signing/privy.js";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const POST = withUser(async (user, req, ctx: Ctx) => {
  const { id } = await ctx.params;
  const body = await jsonBody(req);
  const enabled = body.enabled === true;

  const portfolio = await portfolioOf(user.id, id);
  if (!portfolio) notFound();

  if (!enabled) {
    // Stop first, then withdraw the grant. This order is the one that is safe if
    // the request is interrupted halfway: a stopped portfolio with a standing
    // grant does nothing, while a running portfolio whose grant was withdrawn
    // would spend a cycle discovering it cannot sign.
    await setState(user.id, id, "stopped", "switched off by the user");
    await setDelegated(user.id, portfolio!.walletId, false);
    await record(id, "autopilot.disabled", "info", "Autopilot switched off by the user.");
    const after = await portfolioOf(user.id, id);
    return NextResponse.json({ view: await buildView(after!) });
  }

  if (!privyConfigured()) {
    badRequest("this deployment cannot sign for wallets — PRIVY_APP_ID and PRIVY_APP_SECRET are not configured");
  }
  // The wallet id, which Privy issues only at delegation. The browser has it now
  // and the worker will need it at 3am, so this request is where it is recorded.
  const privyWalletId = typeof body.privyWalletId === "string" ? body.privyWalletId.trim() : "";
  if (privyWalletId.length > 200) badRequest("privyWalletId is not a wallet id");
  if (privyWalletId) {
    await upsertWallet({
      userId: user.id,
      address: portfolio!.address,
      kind: "portfolio",
      privyWalletId,
    });
  } else if (!portfolio!.privyWalletId) {
    badRequest("this portfolio has no Rivo wallet id yet — complete the Privy prompt so Rivo can be given one");
  }
  // The browser reports that the user completed Privy's delegation prompt. It is
  // recorded, not trusted as a permission: the worker asks Privy to sign, and
  // Privy refuses if the grant is not real. What this flag actually controls is
  // whether Rivo BOTHERS to ask — so a false claim here produces a portfolio
  // that fails to sign, not one that signs without consent.
  if (body.delegated !== true) {
    badRequest("Autopilot needs your permission to sign. Complete the prompt from Privy and try again.");
  }

  await setDelegated(user.id, portfolio!.walletId, true);
  await updatePolicy(user.id, id, { mode: "autopilot" });
  const started = await setState(user.id, id, "running", null);
  if (!started) notFound();
  await record(id, "autopilot.enabled", "info", "Autopilot enabled — Rivo may now trade this portfolio.", {
    address: portfolio!.address,
  });

  return NextResponse.json({ view: await buildView(started!) });
});
