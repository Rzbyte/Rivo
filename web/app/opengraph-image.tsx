// The card a shared link becomes.
//
// A submission is a link before it is a page — pasted into a form, a Discord
// channel, a message. Without this the preview carries a title and a sentence
// and a blank rectangle, which reads as an unfinished project regardless of
// what is behind the link.
//
// Rendered rather than shipped as a file so it cannot drift from the product's
// palette, and so there is no binary in the repository to keep in sync.

import { ImageResponse } from "next/og";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "Rivo — Event Intelligence & Agent Validation for DreamDEX";

export default function Image() {
  // The venue mark: two assets across four tenors, the same eight squares the
  // nav uses. Built from divs because Satori has no SVG shape support worth
  // relying on.
  const square = { width: 26, height: 26, background: "#2f5233" };
  const row = { display: "flex", gap: 16 };

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#f4f1ea",
          padding: "68px 76px",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={row}>
            {[0, 1, 2, 3].map((i) => (
              <div key={`a${i}`} style={square} />
            ))}
          </div>
          <div style={row}>
            {[0, 1, 2, 3].map((i) => (
              <div key={`b${i}`} style={{ ...square, opacity: 0.55 }} />
            ))}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
          {/* Three rows rather than <br/>. Satori refuses any div with more
              than one child that does not declare a display mode, and a line
              break counts as a child. */}
          <div style={{ display: "flex", flexDirection: "column", fontSize: 62, fontWeight: 700, color: "#1c1c18", lineHeight: 1.14 }}>
            <div style={{ display: "flex" }}>Event Contracts</div>
            <div style={{ display: "flex" }}>you can check</div>
            <div style={{ display: "flex" }}>before you trade them.</div>
          </div>
          <div style={{ display: "flex", fontSize: 27, color: "#55564d", maxWidth: 900, lineHeight: 1.4 }}>
            A forecast nobody has scored is an opinion with a number on it. 2,179 settled windows say
            how often DreamDEX&rsquo;s were right.
          </div>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-end",
            fontSize: 21,
            color: "#8a8b7f",
            letterSpacing: "0.06em",
            textTransform: "uppercase",
          }}
        >
          <div style={{ display: "flex" }}>Rivo</div>
          <div style={{ display: "flex" }}>Somnia · DreamDEX Event Contracts</div>
        </div>
      </div>
    ),
    size,
  );
}
