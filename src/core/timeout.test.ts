// The fallback path exists for browsers without AbortSignal.timeout — Safari 15
// and older — where an unguarded call fails at module load and renders a blank
// page with no way to explain itself. So the fallback is tested by removing the
// static method, which is the only way to reach it on a modern runtime.

import { afterEach, describe, expect, it } from "vitest";
import { timeoutSignal } from "./timeout.js";

const S = globalThis.AbortSignal as typeof AbortSignal & { timeout?: (ms: number) => AbortSignal };
const original = S.timeout;
afterEach(() => {
  if (original) S.timeout = original;
});

describe("timeoutSignal", () => {
  it("uses AbortSignal.timeout when the runtime has it", () => {
    let seen = 0;
    S.timeout = ((ms: number) => {
      seen = ms;
      return new AbortController().signal;
    }) as typeof S.timeout;
    const sig = timeoutSignal(1234);
    expect(seen).toBe(1234);
    expect(sig).toBeInstanceOf(AbortSignal);
  });

  it("falls back to an AbortController when the static method is missing", async () => {
    delete (S as { timeout?: unknown }).timeout;
    const sig = timeoutSignal(20)!;
    expect(sig).toBeInstanceOf(AbortSignal);
    expect(sig.aborted).toBe(false);
    await new Promise((r) => setTimeout(r, 60));
    expect(sig.aborted).toBe(true);
  });

  it("returns a signal that starts unaborted, so a fast request is never cancelled", () => {
    expect(timeoutSignal(5_000)!.aborted).toBe(false);
  });
});
