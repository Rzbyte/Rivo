import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Providers } from "./providers";

/**
 * No web fonts.
 *
 * A previous version of this file loaded Geist, Geist Mono and Instrument Serif
 * through next/font. They were a foreign import: the cockpit at
 * rzbyte.github.io/Rivo is set in the system stacks and reads better for it, and
 * two surfaces of one product should not disagree about what they are set in.
 * The system mono is also the one face guaranteed to have real tabular figures
 * on every platform, which matters more here than a typeface with a name does.
 */
/**
 * The one piece of copy most readers see before any other.
 *
 * This said "autonomous portfolio manager" and pitched setting a budget once —
 * the product Rivo stopped being.
 *
 * The landing page had its own correct title and hid the problem: `/` looked
 * right, and every other route — /markets, /calibration, /agents, /proof —
 * inherited this fallback and advertised the old product. The pages carrying
 * the actual argument were the ones getting it wrong, and the one page anybody
 * checked was the one page that was fine.
 *
 * So the title is defined ONCE, here, and the landing page no longer overrides
 * it. Two definitions that agree today is how the first one got stale.
 *
 * Pinned by web/identity.test.ts, because the failure mode is silence: nothing
 * renders a <title> wrongly, it just says the wrong thing.
 */
export const metadata: Metadata = {
  title: "Rivo — Event Intelligence & Agent Validation for DreamDEX",
  description:
    "DreamDEX says BTC UP 15m is 67%. Rivo measures whether contracts quoted at 67% actually settled true 67% of the time — and tests an agent against live markets before it trades.",
  // Shared into a Discord or a group chat, a submission is a link preview
  // before it is a page. Without these it inherits the title above and nothing
  // else, which is the one context where the old identity would have survived
  // the fix.
  openGraph: {
    title: "Rivo — Event Intelligence & Agent Validation for DreamDEX",
    description:
      "Understand the market. Validate the agent. Prove it on DreamDEX. Calibration measured over settled windows, and an execution gate that reads the economics rather than the accuracy.",
    type: "website",
  },
};

/**
 * The tag whose absence makes a phone render the page at 980px and shrink it.
 *
 * Without this every dashboard on a handset arrived zoomed out to about a third
 * of legible size, and the responsive rules in globals.css would never have
 * fired, because the browser never reports the real viewport width.
 *
 * `maximumScale` is deliberately absent. Locking zoom is the usual companion to
 * this tag and it takes pinch-to-zoom away from anyone who needs it; the iOS
 * focus-zoom it is normally used to suppress is fixed properly, by sizing inputs
 * at 16px under a coarse pointer.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
