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
import { useState, useEffect } from "react";

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
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (isOpen) document.body.style.overflow = "hidden";
    else document.body.style.overflow = "";
    return () => { document.body.style.overflow = ""; };
  }, [isOpen]);

  return (
    <>
      <header className="top">
        <div className="wrap">
          <Link className="brand" href="/" onClick={() => setIsOpen(false)}>
            <span className="brand-dot" aria-hidden="true" />
            Rivo
          </Link>
          
          <nav className="nav-links hide-mobile" aria-label="Sections">
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
          
          {right && <div className="nav-right row hide-mobile">{right}</div>}

          {/* The right slot. Empty, it made a centred nav read as off-centre;
              filled with the primary action, the header balances and the one
              thing a first-time visitor should do follows them across the site. */}
          <Link
            className="nav-cta"
            href="/check"
            aria-current={path === "/check" ? "page" : undefined}
          >
            Check a price
          </Link>

          <button 
            className="mobile-toggle hide-desktop" 
            onClick={() => setIsOpen(!isOpen)}
            aria-label="Toggle menu"
          >
            {isOpen ? (
              <svg viewBox="0 0 24 24" width="24" height="24" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            ) : (
              <svg viewBox="0 0 24 24" width="24" height="24" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg>
            )}
          </button>
        </div>
      </header>

      {isOpen && (
        <div className="mobile-overlay animate-fade-in hide-desktop">
          <nav className="mobile-nav">
            {SECTIONS.map(([href, label, hint]) => (
              <Link
                key={href}
                href={href}
                className={path === href || path.startsWith(`${href}/`) ? "active" : ""}
                aria-current={path === href || path.startsWith(`${href}/`) ? "page" : undefined}
                onClick={() => setIsOpen(false)}
              >
                {label}
                {/* The desktop nav carries this as a tooltip, which a phone has
                    no way to show. On a handset there is room for it on the
                    row, and it is what tells a first-time reader which of six
                    sections answers the question they arrived with. */}
                <span className="hint">{hint}</span>
              </Link>
            ))}
            {right && <div className="mobile-nav-right" style={{ marginTop: 24 }} onClick={() => setIsOpen(false)}>{right}</div>}
          </nav>
        </div>
      )}
    </>
  );
}
