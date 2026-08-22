// Telling somebody when it stops — and not telling them forty times.
//
// Two properties, and the second is the one that decides whether alerting is
// used or muted. A drawdown halt is true on EVERY cycle from the moment it
// happens, so an alerter without memory sends the same line every 45 seconds
// until the channel is muted — and the next real alert is invisible too. An
// alerter that cries wolf is worse than none, because it trains the operator.
//
// The other property is that this can never break a cycle. A webhook host being
// down is somebody else's outage; converting it into a missed trading pass would
// be ours.

import { describe, expect, it } from "vitest";
import { Alerter } from "./alert.js";

const collect = () => {
  const calls: { url: string; body: unknown }[] = [];
  return { calls, post: async (url: string, body: unknown) => void calls.push({ url, body }) };
};

describe("saying it once", () => {
  it("sends the first time", async () => {
    const { calls, post } = collect();
    const a = new Alerter({ webhook: "https://hook.test", post });
    expect(await a.fire("halted", "breaker fired at 35%")).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("does not send the same news again", async () => {
    const { calls, post } = collect();
    const a = new Alerter({ webhook: "https://hook.test", post });
    for (let i = 0; i < 40; i++) await a.fire("halted", "breaker fired at 35%");
    expect(calls).toHaveLength(1);
  });

  it("does send when the news changes", async () => {
    // "3 consecutive errors" and "10 consecutive errors" are different facts,
    // and the second one matters more than the first.
    const { calls, post } = collect();
    const a = new Alerter({ webhook: "https://hook.test", post });
    await a.fire("errors", "3 consecutive cycle errors");
    await a.fire("errors", "10 consecutive cycle errors");
    expect(calls).toHaveLength(2);
  });

  it("lets a condition become news again after it clears", async () => {
    // A recovered run that fails later must be able to say so.
    const { calls, post } = collect();
    const a = new Alerter({ webhook: "https://hook.test", post });
    await a.fire("errors", "3 consecutive cycle errors");
    a.clear("errors");
    await a.fire("errors", "3 consecutive cycle errors");
    expect(calls).toHaveLength(2);
  });

  it("clearing one kind leaves the others suppressed", async () => {
    const { calls, post } = collect();
    const a = new Alerter({ webhook: "https://hook.test", post });
    await a.fire("halted", "breaker fired");
    await a.fire("errors", "3 errors");
    a.clear("errors");
    await a.fire("halted", "breaker fired");
    expect(calls).toHaveLength(2);
  });
});

describe("where it sends", () => {
  it("sends a body both Slack and Discord can read", async () => {
    const { calls, post } = collect();
    await new Alerter({ webhook: "https://hook.test", post }).fire("halted", "breaker fired");
    const body = calls[0]!.body as { text: string; content: string };
    expect(body.text).toContain("breaker fired");
    expect(body.content).toBe(body.text);
  });

  it("sends to Telegram when a token and chat are given", async () => {
    const { calls, post } = collect();
    const a = new Alerter({ telegramToken: "T", telegramChat: "42", post });
    await a.fire("halted", "breaker fired");
    expect(calls[0]!.url).toContain("api.telegram.org/botT/sendMessage");
    expect((calls[0]!.body as { chat_id: string }).chat_id).toBe("42");
  });

  it("sends to both when both are configured", async () => {
    const { calls, post } = collect();
    const a = new Alerter({ webhook: "https://hook.test", telegramToken: "T", telegramChat: "42", post });
    await a.fire("halted", "breaker fired");
    expect(calls).toHaveLength(2);
  });

  it("does nothing, quietly, when nothing is configured", async () => {
    const { calls, post } = collect();
    const a = new Alerter({ post });
    expect(a.configured).toBe(false);
    expect(await a.fire("halted", "breaker fired")).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("it cannot break the cycle", () => {
  it("swallows a webhook that throws", async () => {
    const a = new Alerter({
      webhook: "https://hook.test",
      post: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    await expect(a.fire("halted", "breaker fired")).resolves.toBe(true);
  });

  it("still delivers to the other channel when one fails", async () => {
    const seen: string[] = [];
    const a = new Alerter({
      webhook: "https://hook.test",
      telegramToken: "T",
      telegramChat: "42",
      post: async (url) => {
        seen.push(url);
        if (url.startsWith("https://hook.test")) throw new Error("down");
      },
    });
    await a.fire("halted", "breaker fired");
    expect(seen.some((u) => u.includes("telegram"))).toBe(true);
  });
});
