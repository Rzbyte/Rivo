"use client";

// Detail a reader wants only if they ask.
//
// Every section this product grew was appended to the column, and nobody
// decided what belongs on first sight against what belongs one click away. The
// Agents page reached twenty-six stacked blocks — seven headings, thirteen
// panels, four tables — which is not a dense page, it is an endless one.
//
// The rule applied here: a page states its answer, and the working that produced
// it is available rather than in the way. Nothing is removed; the fold tables,
// the edge buckets and the gate's reasons are all still there, and a judge
// checking the arithmetic is one click from all of it.

export function Reveal({
  title,
  hint,
  children,
  open = false,
}: {
  title: string;
  /** What is inside, in a few words, so the control is worth pressing. */
  hint?: string;
  children: React.ReactNode;
  open?: boolean;
}) {
  return (
    <details className="reveal" open={open}>
      <summary>
        <span className="t">{title}</span>
        {hint && <span className="h">{hint}</span>}
      </summary>
      <div className="reveal-body">{children}</div>
    </details>
  );
}
