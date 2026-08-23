// Turning a machine's complaint into a sentence.
//
// A refusal and a malfunction arrive through the same field. `binding` is
// whatever explains why a leg did not become a trade, and most of the time that
// is a phrase the engine wrote on purpose — "edge -0.015 below floor". But when
// a chain call throws, the exception lands here verbatim, and viem's exceptions
// are addressed to a developer holding a debugger: six lines of encoded
// calldata, an ABI signature, a documentation link.
//
// One of those rendered untouched into a rounded pill in the decision feed. It
// was the largest element on the page, it said "An unknown error occurred", and
// it was sitting in a product whose whole promise is that you do not have to
// watch it. That is not a truncation problem — cutting it to 150 characters
// still leaves a stack trace, just a shorter one.
//
// So known faults are translated to a short sentence that says what happened
// and, where there is one, what the person can do about it. The original text
// is never destroyed: it stays in the `title` attribute, in the ledger, and in
// `npm run proof`. What changes is only what is rendered by default.

/**
 * Machine text on the left, what a person needs to know on the right.
 *
 * Ordered, and the order is load-bearing: a failed approval whose real cause is
 * a rejected signature matches both the third rule and the first, and the first
 * is the one that names something the user can act on. Root cause before
 * symptom.
 */
const TRANSLATIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /authorization[- ]signature|No valid authorization signatures/i,
    "Rivo was not allowed to sign — reconnect Autopilot",
  ],
  [/insufficient funds|exceeds the balance/i, "Not enough STT left to pay the network fee"],
  [/approving pool/i, "Could not get permission to spend your tUSDC here"],
  [/placeBinaryOrder reverted|execution reverted|reverted: for an unknown reason/i, "The venue turned this order down"],
  [/nonce (too low|has already been used)|replacement transaction underpriced/i, "Two orders collided — Rivo will try again"],
  [/timeout|timed out|ETIMEDOUT|ECONNRESET|ENOTFOUND|fetch failed/i, "The venue did not answer in time"],
  [/rate limit|429/i, "The venue asked Rivo to slow down"],
];

/** Whether this reason is Rivo failing, rather than Rivo declining. */
export function isFault(binding: string): boolean {
  return TRANSLATIONS.some(([re]) => re.test(binding));
}

/**
 * The reason, as a person should read it.
 *
 * A known fault becomes its sentence. Everything else — which is to say every
 * deliberate refusal, the overwhelming majority — is passed through untouched
 * apart from length, because the engine already wrote those for a human.
 */
export function humanise(binding: string, max = 150): string {
  for (const [re, plain] of TRANSLATIONS) {
    if (re.test(binding)) return plain;
  }
  return shorten(binding, max);
}

/**
 * A reason, cut to something readable.
 *
 * Prefers a sentence boundary over a hard slice, so a two-sentence binding
 * renders as its first sentence rather than as its first sentence and a stub of
 * the second.
 */
export function shorten(binding: string, max = 150): string {
  const collapsed = binding.replace(/\s+/g, " ").trim();
  const firstSentence = collapsed.split(/(?<=\.)\s/)[0] ?? collapsed;
  const text = firstSentence.length < collapsed.length && firstSentence.length > 40 ? firstSentence : collapsed;
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()}…`;
}
