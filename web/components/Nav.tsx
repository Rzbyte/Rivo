"use client";

// The four things Rivo does, in the order a person needs them.
//
// UNDERSTAND → VALIDATE → PROVE. Markets and Calibration answer what a
// probability means; Agents answers whether a model deserves capital; Proof is
// what actually happened on-chain. Nothing about wallets, funding or workers is
// here, because none of it is why somebody arrives.

import Link from "next/link";
import { usePathname } from "next/navigation";

const SECTIONS = [
  ["/markets", "Markets", "Live Event Contracts"],
  ["/calibration", "Calibration", "Is the price the real probability?"],
  ["/agents", "Agents", "Does the model deserve capital?"],
  ["/proof", "Proof", "What happened on-chain"],
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
