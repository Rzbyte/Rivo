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
export const metadata: Metadata = {
  title: "Rivo — autonomous portfolio manager for DreamDEX Event Contracts",
  description:
    "Set a budget and a risk profile once. Rivo prices every live Event Contract window, sizes the whole term structure as one exposure, and manages it while you are offline.",
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
