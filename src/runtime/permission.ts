// The gate between "the model has an opinion" and "the user's money moves.
//
// This module exists because of a contradiction the repository was carrying in
// the open. `src/research/gating.ts` evaluates a candidate strategy against
// out-of-sample economics and returns REJECTED for the one in production — and
// `mayExecuteLive()`, the function that reads that verdict, was called by
// exactly one place: the research CLI. The worker asked a different and much
// smaller question,
//
//     mayTradeLive(portfolio) && authority.available()
//
// which is "did the user switch Autopilot on, and can we still sign". Both are
// necessary. Neither knows anything about whether the forecast has ever been
// shown to make money. So a strategy this repository's own evidence calls
// economically rejected could reach `executor.buy()` with a real balance behind
// it, and nothing in the path would object.
//
// Five things now have to agree before capital moves:
//
//     strategy state · execution mode · network · signer · portfolio risk
//
// Portfolio risk stays where it is — the allocator, the exposure limits and the
// breaker are unchanged and still run afterwards. What is added here is the
// first four, and the rule that when any of them is missing or unrecognised the
// answer is no.
//
// FAIL CLOSED IS THE WHOLE DESIGN. Every unknown is a denial, including an
// execution mode this build has never heard of, a strategy with no recorded
// verdict, and a network whose identity cannot be established. A gate that
// defaults to permitting is not a gate.

import type { StrategyState } from "../research/gating.js";

/**
 * What a portfolio's owner has asked for.
 *
 * Three states rather than an `autopilot` boolean, because the boolean could
 * not express the thing this deployment actually needs: run a strategy that
 * failed economic validation, against a testnet, on purpose, for research —
 * without that ever being a step away from doing the same to real money.
 */
export type ExecutionMode = "shadow" | "experimental_testnet" | "validated_autopilot";

export const EXECUTION_MODES: readonly ExecutionMode[] = ["shadow", "experimental_testnet", "validated_autopilot"];

export const isExecutionMode = (v: unknown): v is ExecutionMode =>
  typeof v === "string" && (EXECUTION_MODES as readonly string[]).includes(v);

/**
 * Does this mode INTEND to move capital?
 *
 * Not the same question as `executionPermission` — this one is about what the
 * owner asked for, before the strategy, the network and the signer get a vote.
 * It exists so the several places that used to test `mode === "autopilot"` say
 * what they mean instead of enumerating the modes that are not shadow, which is
 * the form that silently omits a mode added later.
 */
export const modeIntendsExecution = (m: unknown): boolean => isExecutionMode(m) && m !== "shadow";

/** Why capital did not move. Persisted, so a refusal can be read back later. */
export type DenyReason =
  /** The strategy was evaluated and failed. It may never touch real capital. */
  | "STRATEGY_REJECTED"
  /** The strategy has never been evaluated. Absence of evidence is not permission. */
  | "STRATEGY_UNVALIDATED"
  /** The strategy may compute and record, and may not spend. */
  | "SHADOW_ONLY"
  /** The owner has not asked for execution. */
  | "MODE_IS_SHADOW"
  /** A strategy that is not VALIDATED needs the experimental mode, explicitly. */
  | "EXPERIMENTAL_TESTNET_REQUIRED"
  /** Experimental execution is testnet-only, and this is not an approved testnet. */
  | "NETWORK_NOT_APPROVED_FOR_EXPERIMENTAL"
  /** An UNVALIDATED strategy needs the experimental mode AND an explicit opt-in. */
  | "EXPERIMENTAL_NOT_CONFIGURED"
  /** No signer, or the grant is gone. */
  | "SIGNER_UNAVAILABLE"
  /** The user never delegated, or the wallet id is missing. */
  | "DELEGATION_MISSING"
  // --- the fail-closed family: something could not be established at all ---
  | "MODE_UNKNOWN"
  | "STRATEGY_UNKNOWN"
  | "NETWORK_UNKNOWN";

/** A strategy's identity and its standing. Both are required. */
export interface StrategyIdentity {
  id: string;
  label: string;
  state: StrategyState;
  /** Where the verdict came from, so the UI can point at it rather than assert it. */
  evidence?: string;
}

export interface PermissionInput {
  /** From the portfolio row. Anything unrecognised denies. */
  mode: unknown;
  /** The strategy the engine will actually run. Null denies. */
  strategy: StrategyIdentity | null | undefined;
  /** Resolved network identity. Anything but a known network denies. */
  network: unknown;
  /** Whether a signer could be obtained this cycle. */
  signerAvailable: boolean;
  /** Whether the user's grant is on record. */
  delegated: boolean;
  privyWalletId: string | null | undefined;
  /**
   * Whether this deployment has explicitly opted an UNVALIDATED strategy into
   * experimental execution. Off unless someone turned it on.
   */
  allowUnvalidatedExperimental?: boolean;
}

export interface Permission {
  /** True only when every reason list is empty. */
  mayMoveCapital: boolean;
  /** Empty iff permitted. Ordered most-fundamental first. */
  reasons: DenyReason[];
  /** The mode, once validated. Null when it could not be established. */
  mode: ExecutionMode | null;
  /** One line, for a log or a panel. Never claims more than the reasons do. */
  summary: string;
}

/**
 * Networks on which experimental execution of a non-validated strategy is
 * permitted. Testnet only, by name, and not derived from a boolean anywhere.
 *
 * The point of a list rather than `network !== "mainnet"` is that an unknown
 * value fails the membership test instead of passing a negation.
 */
export const EXPERIMENTAL_NETWORKS: readonly string[] = ["testnet"];

const EXPLAIN: Record<DenyReason, string> = {
  STRATEGY_REJECTED: "the strategy failed out-of-sample economic validation and may not receive real capital",
  STRATEGY_UNVALIDATED: "the strategy has never been economically validated",
  SHADOW_ONLY: "the strategy is shadow-only: it may decide and record, not spend",
  MODE_IS_SHADOW: "this portfolio is in Shadow Mode",
  EXPERIMENTAL_TESTNET_REQUIRED: "a strategy that is not validated needs Experimental Testnet, chosen explicitly",
  NETWORK_NOT_APPROVED_FOR_EXPERIMENTAL: "experimental execution is testnet-only and this network is not an approved testnet",
  EXPERIMENTAL_NOT_CONFIGURED: "an unvalidated strategy needs this deployment to opt in explicitly",
  SIGNER_UNAVAILABLE: "no signer is available for this portfolio",
  DELEGATION_MISSING: "the wallet has not delegated signing to Rivo",
  MODE_UNKNOWN: "the portfolio's execution mode could not be established",
  STRATEGY_UNKNOWN: "no strategy identity or verdict was supplied",
  NETWORK_UNKNOWN: "the network could not be established",
};

/**
 * May this portfolio move capital right now?
 *
 * Deliberately pure and synchronous: it reads facts and returns a verdict, so
 * it can be exercised exhaustively in tests and cannot fail open because a
 * network call timed out.
 */
export function executionPermission(input: PermissionInput): Permission {
  const reasons: DenyReason[] = [];

  // --- the four things that must be knowable at all ------------------------
  const mode = isExecutionMode(input.mode) ? input.mode : null;
  if (mode === null) reasons.push("MODE_UNKNOWN");

  const strategy = input.strategy;
  if (!strategy || !strategy.id || !strategy.state) reasons.push("STRATEGY_UNKNOWN");

  const network = typeof input.network === "string" && input.network.trim() !== "" ? input.network : null;
  if (network === null) reasons.push("NETWORK_UNKNOWN");

  // --- authority -----------------------------------------------------------
  if (!input.delegated || !input.privyWalletId) reasons.push("DELEGATION_MISSING");
  if (!input.signerAvailable) reasons.push("SIGNER_UNAVAILABLE");

  // Nothing below can be evaluated without the three above, and evaluating it
  // anyway is how a gate acquires a path that permits on malformed input.
  if (mode === null || !strategy || network === null) {
    return { mayMoveCapital: false, reasons: dedupe(reasons), mode, summary: summarise(false, mode, dedupe(reasons)) };
  }

  // --- mode and strategy, together -----------------------------------------
  if (mode === "shadow") {
    reasons.push("MODE_IS_SHADOW");
  } else if (strategy.state === "SHADOW_ONLY") {
    // Shadow-only outranks the mode: a strategy in this state may not spend
    // regardless of what the owner selected, on any network.
    reasons.push("SHADOW_ONLY");
  } else if (mode === "validated_autopilot") {
    if (strategy.state === "REJECTED") reasons.push("STRATEGY_REJECTED");
    else if (strategy.state !== "VALIDATED") reasons.push("STRATEGY_UNVALIDATED");
  } else if (mode === "experimental_testnet") {
    // The one path by which a strategy that is not VALIDATED may trade, and it
    // is bounded by network on one side and by an explicit choice on the other.
    if (!EXPERIMENTAL_NETWORKS.includes(network)) {
      reasons.push("NETWORK_NOT_APPROVED_FOR_EXPERIMENTAL");
    }
    if (strategy.state === "UNVALIDATED" && input.allowUnvalidatedExperimental !== true) {
      reasons.push("EXPERIMENTAL_NOT_CONFIGURED");
    }
  }

  const out = dedupe(reasons);
  return { mayMoveCapital: out.length === 0, reasons: out, mode, summary: summarise(out.length === 0, mode, out) };
}

const dedupe = (xs: DenyReason[]): DenyReason[] => [...new Set(xs)];

function summarise(allowed: boolean, mode: ExecutionMode | null, reasons: DenyReason[]): string {
  if (allowed) {
    return mode === "experimental_testnet"
      ? "Executing on an approved testnet under Experimental Testnet mode."
      : "Executing under a validated strategy.";
  }
  if (reasons.length === 0) return "No execution permission.";
  return `No capital will move: ${reasons.map((r) => EXPLAIN[r]).join("; ")}.`;
}

/** Human-readable form of one reason, for a log line or a panel. */
export const explainDenial = (r: DenyReason): string => EXPLAIN[r];

/**
 * How the mode should be described to somebody who did not write it.
 *
 * Kept next to the semantics rather than in the web app, so a label cannot
 * drift away from the rule it describes.
 */
export const MODE_LABEL: Record<ExecutionMode, string> = {
  shadow: "Shadow Mode",
  experimental_testnet: "Experimental Testnet",
  validated_autopilot: "Autopilot",
};
