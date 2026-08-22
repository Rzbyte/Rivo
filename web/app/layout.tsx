import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "Rivo — autonomous portfolio manager for DreamDEX Event Contracts",
  description:
    "Set a budget and a risk profile once. Rivo prices every live Event Contract window, sizes the whole term structure as one exposure, and manages it while you are offline.",
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
