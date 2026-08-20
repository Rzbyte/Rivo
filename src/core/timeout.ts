// A bounded-request signal that works everywhere the page can run.
//
// `AbortSignal.timeout()` is the right primitive and is missing from Safari 15
// and older, which still shows up on iPads people actually hand to each other.
// Reaching for it unguarded turns an unsupported browser into a blank page —
// the failure lands at module load, before anything can render an explanation.
//
// The fallback is an AbortController with a timer, which is what the static
// method is shorthand for. The timer is unref'd where that exists so a Node
// process is never held open by a request that already settled.

export function timeoutSignal(ms: number): AbortSignal | undefined {
  const S = globalThis.AbortSignal as (typeof AbortSignal & { timeout?: (ms: number) => AbortSignal }) | undefined;
  if (S?.timeout) return S.timeout(ms);
  if (typeof AbortController === "undefined") return undefined; // ancient: unbounded, but reachable
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`timed out after ${ms}ms`)), ms);
  (timer as unknown as { unref?: () => void }).unref?.();
  return ctrl.signal;
}
