"use client";

// The things Rivo does, in the order a person needs them.
//
// CHECK → UNDERSTAND → VALIDATE → PROVE. Check is the ten-second answer for
// somebody about to accept a price; Markets and Calibration are the same
// question with the table left open; Agents answers whether a model deserves
// capital; Proof is what actually happened on-chain; Evidence is every study
// behind those answers, including the two that came back no. Nothing about
// wallets, funding or workers is here, because none of it is why somebody
// arrives.
//
// Check goes first on purpose. Every other entry assumes a reader who already
// knows why a quoted probability is worth interrogating; that one is for the
// reader who does not yet, and a front door behind four other doors is not one.

import Link from "next/link";
import { usePathname } from "next/navigation";

const SECTIONS = [
  ["/check", "Check", "Is this price fair?"],
  ["/markets", "Markets", "Live Event Contracts"],
  ["/calibration", "Calibration", "Is the price the real probability?"],
  ["/agents", "Agents", "Does the model deserve capital?"],
  ["/proof", "Proof", "What happened on-chain"],
  ["/evidence", "Evidence", "Every study, including the negative ones"],
] as const;

export function Nav({ right }: { right?: React.ReactNode }) {
  const path = usePathname();
  return (
    <header className="top">
      <div className="wrap">
        <Link className="brand" href="/">
          <span className="brand-dot" aria-hidden="true" />
          Rivo
        </Link>
        <nav className="nav-links" aria-label="Sections">
          {SECTIONS.map(([href, label, hint]) => (
            <Link
              key={href}
              href={href}
              title={hint}
              aria-current={path === href || path.startsWith(`${href}/`) ? "page" : undefined}
            >
              {label}
            </Link>
          ))}
        </nav>
        {right && <div className="nav-right row">{right}</div>}
      </div>
    </header>
  );
}
