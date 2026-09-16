import type { MetadataRoute } from "next";

/**
 * The student app. A route handler rather than `app/manifest.ts`, because
 * the file convention injects its link on every page of every host — and
 * the desk has its own manifest at /desk.webmanifest.
 */
export function GET() {
  const manifest: MetadataRoute.Manifest = {
    name: "Printifi",
    short_name: "Printifi",
    description: "Upload from your phone, pay with UPI, collect a printed set.",
    start_url: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#edebe6",
    theme_color: "#edebe6",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
  return Response.json(manifest, {
    headers: { "content-type": "application/manifest+json", "cache-control": "public, max-age=3600" },
  });
}
