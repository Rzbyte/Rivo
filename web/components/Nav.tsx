"use client";

// The things Rivo does, in the order a person needs them.
//
// THERE IS NO CALL TO ACTION UP HERE, AND THAT IS THE SECOND ANSWER TO THE SAME
// QUESTION. A "Check a price" button lived in the right slot for a while: it
// balanced a centred nav against a wordmark and it put the one useful action on
// every page. Both true, and it still read as an advertisement following the
// reader around a set of pages they had already chosen to open. Asked about
// twice, which is once more than a composition argument is worth.
//
// The balance problem it was solving is solved by geometry instead — the nav
// sits at the right rather than in the middle, so there is no empty slot to
// fill. `/check` is the first entry in the list; anyone who wants it is one tap
// from it on every page.
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
            {SECTIONS.map(([href, label]) => (
              <Link
                key={href}
                href={href}
                className={path === href || path.startsWith(`${href}/`) ? "active" : ""}
                aria-current={path === href || path.startsWith(`${href}/`) ? "page" : undefined}
                onClick={() => setIsOpen(false)}
              >
                {/* No hint here, and the reason is in the destinations.
                    Each one repeated the h1 of the page it points at — "Is this
                    price fair?" is word for word the heading on /check — so the
                    menu was explaining a page that introduces itself a second
                    later in much bigger type. It also broke: "Is the price the
                    real probability?" ran off the right edge of a 390px screen.
                    A menu's job is to get you there. */}
                {label}
              </Link>
            ))}
            {right && <div className="mobile-nav-right" style={{ marginTop: 24 }} onClick={() => setIsOpen(false)}>{right}</div>}
          </nav>
        </div>
      )}
    </>
  );
}
