/**
 * The mark, in one place.
 *
 * Two assets across four tenors — the universe Rivo prices — which is why it is
 * eight cells and not a monogram. The fourth column is deliberately narrower
 * than the other three; that is how the logo is drawn and it keeps the mark from
 * reading as a plain grid.
 *
 * Geometry lifted from the logo file rather than approximated: squares measured
 * 83/83/85px with 14-16px gutters and a 49px final bar, corners rounded to about
 * 18% of the square. Normalised here to a 24 / 4 / 14 grid on a 98×52 viewBox.
 *
 * THE GRADIENT IS NOT THE LOGO'S GRADIENT ON THE LIGHT THEME, ON PURPOSE.
 * The logo ramps #d8f7da → #35dd48 across a near-black ground. Against Rivo's
 * cream (#f4f1ea) that pale end measures 2.0:1 — a mark you cannot see is not a
 * mark. So each theme keeps the gesture (luminance falling, saturation rising,
 * left to right) and re-pitches the endpoints against its own ground:
 *
 *   light   #4f8c58 → #2f5233     3.6:1 and 7.8:1 on #f4f1ea
 *   dark    #d8f7da → #35dd48     the logo verbatim, 11:1 at the dim end
 *
 * Both ends clear the 3:1 that non-text graphics owe a reader. The endpoints are
 * tokens (--mark-a / --mark-b in globals.css) so a theme sets them once.
 *
 * Decorative on purpose: every surface that shows the mark shows the "Rivo"
 * wordmark beside it, so labelling the SVG too would make a screen reader read
 * the brand twice on the way into the nav.
 *
 * `gradientUnits="userSpaceOnUse"` matters: the default resolves the gradient
 * against each shape's own box, which would repeat the full ramp inside all eight
 * cells instead of running it once across the mark.
 */

const CELLS = [
  // x, width — the fourth column is the narrow one, both rows.
  [0, 24],
  [28, 24],
  [56, 24],
  [84, 14],
] as const;

export function BrandMark({ className, size = 20 }: { className?: string; size?: number }) {
  return (
    <svg
      className={className}
      viewBox="0 0 98 52"
      width={(size * 98) / 52}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <linearGradient id="rivo-mark" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="98" y2="0">
        <stop offset="0" style={{ stopColor: "var(--mark-a)" }} />
        <stop offset="1" style={{ stopColor: "var(--mark-b)" }} />
      </linearGradient>
      <g fill="url(#rivo-mark)">
        {[0, 28].map((y) =>
          CELLS.map(([x, w]) => (
            <rect key={`${x}-${y}`} x={x} y={y} width={w} height="24" rx="4.4" />
          )),
        )}
      </g>
    </svg>
  );
}
