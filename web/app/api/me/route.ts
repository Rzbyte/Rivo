// Who is signed in, and what do they have.
//
// Called once after login. It does the one piece of bookkeeping that has to
// happen server-side: recording the Privy wallet the browser just provisioned,
// so the worker can find it later. The browser is the only thing that knows
// which wallet Privy created for this user; the worker is the only thing that
// needs it at 3am. This is where the two meet.

import { NextResponse } from "next/server";
import { badRequest, withUser, withUserWrite } from "@/lib/auth";
import { jsonBody } from "@/lib/validate";
import { upsertWallet, walletsOf } from "@rivo/db/accounts.js";
import { portfoliosOf } from "@rivo/db/portfolios.js";
import { privyConfigured } from "@rivo/signing/privy.js";

export const dynamic = "force-dynamic";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export const GET = withUser(async (user) => {
  const [wallets, portfolios] = await Promise.all([walletsOf(user.id), portfoliosOf(user.id)]);
  return NextResponse.json({
    user: { id: user.id, email: user.email, createdAt: user.createdAt },
    wallets: wallets.map((w) => ({
      id: w.id,
      address: w.address,
      kind: w.kind,
      delegated: w.delegated,
      // The wallet id is a capability reference, not a secret, but it is also of
      // no use to a browser — so it does not travel to one.
      canSign: Boolean(w.privyWalletId),
    })),
    portfolios: portfolios.map((p) => ({
      id: p.id,
      address: p.address,
      network: p.network,
      capital: p.policy.capital,
      profile: p.policy.profile,
      mode: p.policy.mode,
      state: p.policy.state,
    })),
    serverCanSign: privyConfigured(),
  });
});

/**
 * Register a wallet this user owns.
 *
 * `kind` decides what Rivo may ever do with it, and the difference is the
 * product's central safety property:
 *
 *   portfolio — the Privy wallet Rivo trades. Requires a Privy wallet id,
 *               without which no signature can be requested.
 *   external  — a wallet used to sign in or to fund from. No wallet id is
 *               recorded, so there is nothing to ask even in principle.
 *
 * An external wallet can never be promoted: `upsertWallet` keeps the existing
 * kind on conflict, so a client cannot turn the user's hardware wallet into
 * something Rivo signs with by re-posting it with a different label.
 */
export const POST = withUserWrite(async (user, req) => {
  const body = await jsonBody(req);
  const address = String(body.address ?? "");
  if (!ADDRESS.test(address)) badRequest("address must be a 20-byte hex address");
  const kind = body.kind === "portfolio" ? "portfolio" : "external";
  const privyWalletId = typeof body.privyWalletId === "string" ? body.privyWalletId.trim() : "";
  if (privyWalletId.length > 200) badRequest("privyWalletId is not a wallet id");
  // The id arrives LATER than the address. Privy issues one only once the user
  // has delegated, so registering the wallet at login and completing it at the
  // Autopilot step is the real sequence rather than a workaround for one.
  const wallet = await upsertWallet({
    userId: user.id,
    address,
    kind,
    ...(kind === "portfolio" && privyWalletId ? { privyWalletId } : {}),
  });
  return NextResponse.json({
    wallet: { id: wallet.id, address: wallet.address, kind: wallet.kind, delegated: wallet.delegated },
  });
});
