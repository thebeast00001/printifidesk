import { requestSurface } from "@/lib/server/surface";
import { PUBLIC_PAGES, canonical } from "@/lib/seo";

export const dynamic = "force-dynamic";

/** The student site's public pages, and nothing on the desk site. */
export async function GET() {
  const surface = await requestSurface();
  if (surface === "desk") return new Response("Not found", { status: 404 });
  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...PUBLIC_PAGES.map(
      (p) =>
        `  <url><loc>${canonical(p.path)}</loc>${p.lastModified ? `<lastmod>${p.lastModified}</lastmod>` : ""}<changefreq>${p.changeFrequency}</changefreq><priority>${p.priority}</priority></url>`,
    ),
    "</urlset>",
  ].join("\n");
  return new Response(body + "\n", {
    headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" },
  });
}
