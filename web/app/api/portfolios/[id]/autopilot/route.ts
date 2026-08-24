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
import { executionPermission, isExecutionMode } from "@rivo/runtime/permission.js";
import { PRODUCTION_STRATEGY } from "@rivo/research/gating.js";
import { badRequest, notFound, withUserWrite } from "@/lib/auth";
import { jsonBody } from "@/lib/validate";
import { portfolioOf, setState, updatePolicy } from "@rivo/db/portfolios.js";
import { setDelegated, upsertWallet } from "@rivo/db/accounts.js";
import { record } from "@rivo/db/events.js";
import { buildView } from "@rivo/db/view.js";
import { privyConfigured } from "@rivo/signing/privy.js";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const POST = withUserWrite(async (user, req, ctx: Ctx) => {
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
    // No prompt exists to tell them to complete. These wallets run in a
    // TEE, where the grant is provisioned headlessly, so a message naming a
    // Privy prompt sends somebody looking for a window that never opens.
    badRequest(
      "This portfolio has no Rivo wallet yet. Reload the page so Rivo can pick up the wallet Privy created for you, then try again.",
    );
  }
  // The browser reports that the user completed Privy's delegation prompt. It is
  // recorded, not trusted as a permission: the worker asks Privy to sign, and
  // Privy refuses if the grant is not real. What this flag actually controls is
  // whether Rivo BOTHERS to ask — so a false claim here produces a portfolio
  // that fails to sign, not one that signs without consent.
  if (body.delegated !== true) {
    badRequest(
      "Rivo did not receive permission to sign for this wallet. There is no separate prompt to approve — " +
        "the Enable button on the previous screen IS the consent. Go back and press it again.",
    );
  }

  // Which mode is being asked for, and would it actually be allowed?
  //
  // Enabling execution used to write `mode: "autopilot"` unconditionally. That
  // is now a decision with consequences — `validated_autopilot` is the mode
  // that may spend on any network, and the strategy running here failed
  // economic validation — so the request names a mode, the default is the
  // conservative one, and anything the gate would refuse is refused HERE rather
  // than accepted and quietly ignored by the worker later.
  const requested = isExecutionMode(body.mode) ? body.mode : "experimental_testnet";
  const wouldRun = executionPermission({
    mode: requested,
    strategy: PRODUCTION_STRATEGY,
    network: portfolio!.network,
    // The two things this request has just established. The worker re-checks
    // both against Privy before it signs anything.
    signerAvailable: true,
    delegated: true,
    privyWalletId: portfolio!.privyWalletId ?? privyWalletId,
    allowUnvalidatedExperimental: process.env.RIVO_ALLOW_UNVALIDATED_EXPERIMENTAL === "true",
  });
  if (!wouldRun.mayMoveCapital) badRequest(wouldRun.summary);

  // A breaker that a routine action clears is not a breaker.
  //
  // `setState(..., "running")` moves a portfolio out of `halted` unconditionally,
  // so enabling execution used to reset the drawdown breaker as a side effect —
  // while the banner beside it said Rivo would not restart on its own. Both
  // cannot be true. Clearing a halt now takes a separate, explicit
  // acknowledgement that names what tripped it.
  if (portfolio!.policy.state === "halted" && body.acknowledgeHalt !== true) {
    badRequest(
      `Trading is halted: ${portfolio!.policy.stoppedReason ?? "a risk limit was breached"}. ` +
        "Enabling execution will not clear that on its own — confirm you have reviewed it first.",
    );
  }

  await setDelegated(user.id, portfolio!.walletId, true);
  await updatePolicy(user.id, id, { mode: requested });
  const started = await setState(user.id, id, "running", null);
  if (!started) notFound();
  if (portfolio!.policy.state === "halted") {
    await record(id, "breaker.cleared", "warn",
      `The owner cleared a halt to enable execution. It had tripped on: ${portfolio!.policy.stoppedReason ?? "an unrecorded reason"}`,
      { address: portfolio!.address, previousReason: portfolio!.policy.stoppedReason });
  }
  await record(id, "autopilot.enabled", "info",
    requested === "experimental_testnet"
      ? "Experimental Testnet enabled — Rivo may now place real orders on the testnet with this portfolio."
      : "Autopilot enabled — Rivo may now trade this portfolio.",
    { address: portfolio!.address, mode: requested, strategy: PRODUCTION_STRATEGY.id, strategyState: PRODUCTION_STRATEGY.state });

  return NextResponse.json({ view: await buildView(started!) });
});
