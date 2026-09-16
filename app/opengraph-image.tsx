import { ImageResponse } from "next/og";
import { BRAND, SITE_HOST, TAGLINE } from "@/lib/seo";

export const alt = `${BRAND} — campus printing from your phone`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/**
 * The card a link to the site unfurls into — in a chat, on a notice board's
 * post, in a search result that shows one. Drawn here from the site's own
 * words, so it can't fall out of step with them.
 */
export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 72,
          background: "#131316",
          color: "#f2efe9",
          fontFamily: "Georgia, serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div style={{ width: 56, height: 56, borderRadius: 16, background: "#f2efe9", display: "flex", alignItems: "center", justifyContent: "center", color: "#131316", fontSize: 34, fontWeight: 800 }}>
            P
          </div>
          <div style={{ fontSize: 40, fontWeight: 800, letterSpacing: -1 }}>{BRAND}</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
          <div style={{ fontSize: 66, fontWeight: 800, lineHeight: 1.05, letterSpacing: -2, maxWidth: 1000 }}>
            Print from your phone. Collect at the desk.
          </div>
          <div style={{ fontSize: 28, color: "#b8b4ad", maxWidth: 960, lineHeight: 1.35 }}>{TAGLINE}</div>
        </div>
        <div style={{ fontSize: 26, color: "#8f8b84", fontFamily: "monospace" }}>{SITE_HOST}</div>
      </div>
    ),
    size,
  );
}
