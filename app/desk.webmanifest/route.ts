import type { MetadataRoute } from "next";
import { requestSurface } from "@/lib/server/surface";

export const dynamic = "force-dynamic";

/**
 * The desk app, installable on its own. Starts at the queue, allows
 * landscape (a tablet propped at a counter), and carries its own mark so
 * two Printifi icons on one phone are never confused.
 *
 * On the desk site the queue is "/" (pinned or on its own host alike);
 * "/operator" only redirects there, and an installed app whose first
 * navigation is a redirect is where Chrome's "This page couldn't load"
 * has been seen. Start on the page itself; only a shared single host,
 * where "/" is the student's home, keeps the internal path.
 */
export async function GET() {
  const surface = await requestSurface();
  const ownHost = surface === "desk";
  const manifest: MetadataRoute.Manifest = {
    name: "Printifi Desk",
    short_name: "Desk",
    description: "The counter's side of Printifi: the queue, the prices, the hours, the handover.",
    start_url: ownHost ? "/" : "/operator",
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
