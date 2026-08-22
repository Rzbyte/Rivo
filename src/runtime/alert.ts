// Telling somebody when it stops.
//
// The single largest gap between "it runs unattended" and "it runs unattended in
// production" was that nothing ever said so. Both canary runs ended with the
// drawdown breaker firing, and both times it was found afterwards by reading a
// log — once a day later. A breaker that halts at 3am and tells nobody has done
// half its job: the capital is protected and the operator still believes the
// thing is trading.
//
// Deliberately small. No queue, no retry, no delivery guarantee, no dependency:
// one POST, and if it fails the cycle carries on. An alerter that can break the
// runtime is worse than no alerter, because it converts somebody else's outage
// into yours.
//
// The body carries `text` AND `content` because Slack reads the first and
// Discord the second, which covers where an operator is likely to want this
// without a per-vendor adapter. Anything speaking plain JSON gets both.

import { timeoutSignal } from "../core/timeout.js";

/** What happened. Used for de-duplication, so a persistent state alerts once. */
export type AlertKind = "halted" | "errors" | "low-gas" | "low-collateral" | "started" | "stopped";

/**
 * A kind an alerter will accept.
 *
 * The closed union above is the single-runtime vocabulary and stays closed —
 * those are the conditions `npm start` knows how to detect, and a typo in one of
 * them should not compile. The worker's vocabulary is open, because its alerts
 * come from the `events` table and that table's `kind` is whatever the code that
 * recorded it chose. The `event:` prefix keeps the two apart, so a de-duplication
 * key from one can never collide with one from the other.
 */
export type AlertTopic = AlertKind | `event:${string}`;

export interface AlertOptions {
  /** Generic JSON webhook. Slack and Discord incoming webhooks both work. */
  webhook?: string;
  /** Telegram bot token, paired with `telegramChat`. */
  telegramToken?: string;
  telegramChat?: string;
  /** Overridable so tests never reach the network. */
  post?: (url: string, body: unknown) => Promise<void>;
}

async function defaultPost(url: string, body: unknown): Promise<void> {
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: timeoutSignal(8_000),
  });
}

/**
 * Fires once per distinct condition, and again when the condition changes.
 *
 * The de-duplication is the whole design. A drawdown halt is true on every cycle
 * from the moment it happens, so an alerter without memory sends the same
 * message every 45 seconds until somebody mutes the channel — at which point the
 * next real alert is invisible too. Keyed by kind AND message, so "3 consecutive
 * errors" and "10 consecutive errors" are different news.
 */
export class Alerter {
  private readonly sent = new Set<string>();
  private readonly post: (url: string, body: unknown) => Promise<void>;

  constructor(private readonly opts: AlertOptions = {}) {
    this.post = opts.post ?? defaultPost;
  }

  /** Whether anywhere is configured to send to. */
  get configured(): boolean {
    return Boolean(this.opts.webhook || (this.opts.telegramToken && this.opts.telegramChat));
  }

  /** Forget a condition, so its recovery can be announced and it can fire again. */
  clear(kind: AlertKind): void {
    for (const key of [...this.sent]) if (key.startsWith(`${kind}:`)) this.sent.delete(key);
  }

  /**
   * Send, unless this exact news has already been sent.
   *
   * Returns whether anything was dispatched, which is what the tests assert on —
   * never whether it arrived, which this cannot know and does not claim.
   */
  async fire(kind: AlertTopic, message: string): Promise<boolean> {
    const key = `${kind}:${message}`;
    if (this.sent.has(key) || !this.configured) return false;
    this.sent.add(key);

    const text = `Rivo — ${message}`;
    const jobs: Promise<void>[] = [];
    if (this.opts.webhook) jobs.push(this.post(this.opts.webhook, { text, content: text }));
    if (this.opts.telegramToken && this.opts.telegramChat) {
      jobs.push(
        this.post(`https://api.telegram.org/bot${this.opts.telegramToken}/sendMessage`, {
          chat_id: this.opts.telegramChat,
          text,
        }),
      );
    }
    // Never let a delivery failure reach the cycle. A muted alert costs
    // attention; a thrown one costs a trading pass.
    await Promise.allSettled(jobs);
    return true;
  }
}

/** Build one from the environment, or a disabled one when nothing is set. */
export function alerterFromEnv(): Alerter {
  return new Alerter({
    webhook: (process.env.RIVO_ALERT_WEBHOOK ?? "").trim() || undefined,
    telegramToken: (process.env.RIVO_ALERT_TELEGRAM_TOKEN ?? "").trim() || undefined,
    telegramChat: (process.env.RIVO_ALERT_TELEGRAM_CHAT ?? "").trim() || undefined,
  });
}
