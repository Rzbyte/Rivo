import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";

/**
 * Three faces, three jobs.
 *
 * Geist is the house sans — it is what safehands.fun is set in, and Rivo is by
 * the same hand. Geist Mono carries every number, because a price, a share count
 * and a transaction hash all need to line up in a column and none of them is
 * prose.
 *
 * Instrument Serif is the deliberate one. Every trading interface in existence
 * is sans plus mono, which is why they all look alike; a high-contrast serif at
 * display size says RECORD rather than TERMINAL, and a record is what this
 * product actually keeps — a decision log that says what was considered, what
 * was refused, and why. It is used only at display size and never below it.
 */
const sans = Geist({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });
const serif = Instrument_Serif({ subsets: ["latin"], weight: "400", style: ["normal", "italic"], variable: "--font-serif", display: "swap" });

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
  themeColor: "#08090F",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} ${serif.variable}`}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
