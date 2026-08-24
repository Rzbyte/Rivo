// Where a settlement comes from.
//
// Rivo's whole claim is that it measures against SETTLED outcomes, and until
// now the settlement was a number handed over by the markets indexer. True, and
// one link short: it does not say who decided, on what schedule, by what
// agreement, or in which transaction.
//
// The Prophecy Oracle publishes exactly that. Every Event Contract window has a
// scheduled question — "What is the price of BTC in USDC at unix time N?" —
// answered by a subcommittee with a stated size and threshold, and the answer is
// written on-chain with its own hash. That hash is a SECOND, independent
// transaction a reader can check: not Rivo's, the oracle's.
//
// It also declares `numericDecimals`, which the markets path does not carry.
// That absence is why scaleReference() has to pick a power of ten by matching
// against a known price — see docs/SDK-FEEDBACK.md §1. The field exists; it just
// does not travel.
//
// Nothing here is load-bearing for trading. It is provenance, fetched when a
// proof is built, and a failure to reach it degrades to null rather than
// breaking the page that asked.

import { VENUE, type Network } from "./venue.js";
import { timeoutSignal } from "./timeout.js";

/** One scheduled question and, once answered, the committee's answer. */
export interface OracleQuestion {
  id: string;
  /** The literal question the committee was asked. */
  text: string;
  /** Scheduled | Resolved | anything else the oracle reports. */
  status: string;
  /** Unix seconds the question is scheduled to resolve — a window's expiry. */
  resolutionTime: number;
  resolvedAt: number | null;
  /** The transaction that wrote the answer. Independent of Rivo's own. */
  resolvedTxHash: string | null;
  resolvedAtBlock: number | null;
  committee: { size: number; threshold: number; minAgreement: number };
  /**
   * The answered value, already scaled by the oracle's OWN declared decimals.
   *
   * Declared, not guessed. This is the field whose absence from the markets path
   * forced scaleReference() to infer a magnitude.
   */
  value: number | null;
  decimals: number | null;
  voided: boolean | null;
}

interface Row {
  id: string;
  questionText: string | null;
  status: string | null;
  resolutionTime: string;
  resolvedAtTimestamp: string | null;
  resolvedTxHash: string | null;
  resolvedAtBlock: string | null;
  minAgreement: number | null;
  subcommitteeSize: number | null;
  subcommitteeThreshold: number | null;
  numericDecimals: number | null;
  answers: { numericValue: string | null; voided: boolean | null }[];
}

const QUERY = `query Q($t: numeric!, $asset: String!) {
  Question(
    where: { resolutionTime: { _eq: $t }, questionText: { _ilike: $asset } }
    limit: 1
  ) {
    id questionText status resolutionTime
    resolvedAtTimestamp resolvedTxHash resolvedAtBlock
    minAgreement subcommitteeSize subcommitteeThreshold numericDecimals
    answers { numericValue voided }
  }
}`;

/**
 * The question a window settles on, matched on its expiry.
 *
 * The join is exact rather than approximate: a window expiring at unix N is
 * settled by the question scheduled for unix N. No tolerance, because a
 * tolerance here would silently attach one window's provenance to another's.
 *
 * Returns null for anything that goes wrong — unreachable, malformed, no match.
 * A proof missing its provenance is worth less than one that has it and far more
 * than a page that failed to render.
 */
export async function questionFor(
  net: Network,
  asset: string,
  expiry: number,
  opts: { timeoutMs?: number } = {},
): Promise<OracleQuestion | null> {
  const url = VENUE[net].oracle;
  if (!url) return null;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: QUERY, variables: { t: String(expiry), asset: `%${asset}%` } }),
      signal: timeoutSignal(opts.timeoutMs ?? 8_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { Question?: Row[] } };
    const q = body.data?.Question?.[0];
    if (!q) return null;

    const answer = q.answers?.[0];
    const decimals = q.numericDecimals;
    const raw = answer?.numericValue ?? null;
    // Scaled by the oracle's own declaration. Guessing here would reintroduce
    // exactly the problem this field exists to remove.
    const value =
      raw !== null && decimals !== null && Number.isFinite(Number(raw))
        ? Number(raw) / 10 ** decimals
        : null;

    return {
      id: q.id,
      text: q.questionText ?? "",
      status: q.status ?? "unknown",
      resolutionTime: Number(q.resolutionTime),
      resolvedAt: q.resolvedAtTimestamp === null ? null : Number(q.resolvedAtTimestamp),
      resolvedTxHash: q.resolvedTxHash,
      resolvedAtBlock: q.resolvedAtBlock === null ? null : Number(q.resolvedAtBlock),
      committee: {
        size: q.subcommitteeSize ?? 0,
        threshold: q.subcommitteeThreshold ?? 0,
        minAgreement: q.minAgreement ?? 0,
      },
      value,
      decimals,
      voided: answer?.voided ?? null,
    };
  } catch {
    return null;
  }
}
