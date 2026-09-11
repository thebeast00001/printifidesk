import type { MetadataRoute } from "next";

/**
 * The desk app, installable on its own. Starts at the queue, allows
 * landscape (a tablet propped at a counter), and carries its own mark so
 * two Printify icons on one phone are never confused.
 */
export function GET() {
  const manifest: MetadataRoute.Manifest = {
    name: "Printify Desk",
    short_name: "Desk",
    description: "The counter's side of Printify: the queue, the prices, the hours, the handover.",
    start_url: "/operator",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#edebe6",
    theme_color: "#1a1a1d",
    icons: [
      { src: "/desk-icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/desk-icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/desk-icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
  return Response.json(manifest, {
    headers: { "content-type": "application/manifest+json", "cache-control": "public, max-age=3600" },
  });
}
