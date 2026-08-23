import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "Rivo — autonomous portfolio manager for DreamDEX Event Contracts",
  description:
    "Set a budget and a risk profile once. Rivo prices every live Event Contract window, sizes the whole term structure as one exposure, and manages it while you are offline.",
};

/**
 * The tag whose absence makes a phone render the page at 980px and shrink it.
 *
 * Without this every dashboard on a handset arrived zoomed out to about a third
 * of legible size, and the responsive rules below would never have fired because
 * the browser never reports the real viewport width. It is one line and it is the
 * difference between "the CSS is responsive" and "the page is".
 *
 * `maximumScale` is deliberately absent. Locking zoom is the usual companion to
 * this tag and it takes pinch-to-zoom away from anyone who needs it; the iOS
 * focus-zoom it is normally used to suppress is fixed properly below, by making
 * inputs 16px.
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
