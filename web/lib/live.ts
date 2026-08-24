"use client";

// One way for a page to stay current.
//
// Every surface had grown its own answer: Markets polled on a bare interval,
// Agents polled only its shadow table, and Calibration and Proof fetched once on
// mount and then showed whatever had been true when the tab opened. A page about
// a live venue that stops moving is a screenshot, and a reader has no way to
// tell the difference.
//
// Three behaviours the hand-rolled versions did not have:
//
//   * IT STOPS WHEN NOBODY IS LOOKING. A background tab polling a venue's
//     indexer every five seconds for an afternoon is somebody else's bill.
//   * IT CATCHES UP ON RETURN. Coming back to a tab should not mean waiting out
//     the rest of an interval to see a stale number replaced.
//   * IT SAYS WHEN IT LAST SUCCEEDED. `updatedAt` lets a page show freshness,
//     which is the only honest way to render data that might be old.

import { useCallback, useEffect, useRef, useState } from "react";

export interface Live<T> {
  data: T | null;
  error: string | null;
  /** Unix ms of the last successful load. Zero before the first. */
  updatedAt: number;
  /** True while a load is in flight and nothing has arrived yet. */
  loading: boolean;
  /** Force a load now. */
  refresh: () => void;
}

export function useLive<T>(url: string, everyMs = 10_000): Live<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState(0);
  const [loading, setLoading] = useState(true);
  // Guards against a slow response from an earlier poll landing after a newer
  // one and putting older data on the screen.
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const res = await fetch(url, { cache: "no-store" });
      const body = (await res.json()) as T & { error?: string };
      if (mine !== seq.current) return;
      if (body && typeof body === "object" && "error" in body && body.error) {
        setError(String(body.error));
      } else {
        setData(body);
        setError(null);
        setUpdatedAt(Date.now());
      }
    } catch {
      if (mine === seq.current) setError("could not reach Rivo");
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = (): void => {
      if (timer) return;
      timer = setInterval(() => void load(), everyMs);
    };
    const stop = (): void => {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    };

    const onVisibility = (): void => {
      if (document.visibilityState === "visible") {
        // Catch up first, then resume. Waiting out the interval would show a
        // stale number to somebody who just came back to look at it.
        void load();
        start();
      } else {
        stop();
      }
    };

    void load();
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load, everyMs]);

  return { data, error, updatedAt, loading, refresh: () => void load() };
}

/** "4s ago", for a freshness line that does not pretend to be live when it is not. */
export function ago(ms: number, now = Date.now()): string {
  if (ms === 0) return "never";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 2) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
}
