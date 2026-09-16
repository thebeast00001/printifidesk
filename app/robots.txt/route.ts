import { requestSurface } from "@/lib/server/surface";
import { SITE_URL } from "@/lib/seo";

export const dynamic = "force-dynamic";

/**
 * Which host is asking decides the answer. The student site is the one to
 * index — its public pages — and never anyone's own pages (orders, profile,
 * receipts) or the doors (sign-in, the desk's tools, the admin's). The desk
 * site is a tool for people who already have it; it asks not to be indexed
 * at all, and its copies of the legal pages carry a canonical link back to
 * the student site.
 */
export async function GET() {
  const surface = await requestSurface();
  const lines =
    surface === "desk"
      ? ["User-agent: *", "Disallow: /"]
      : [
          "User-agent: *",
          "Allow: /",
          "Disallow: /orders",
          "Disallow: /profile",
          "Disallow: /settings",
          "Disallow: /receipt/",
          "Disallow: /admin",
          "Disallow: /operator",
          "Disallow: /diagnostics",
          "Disallow: /join",
          "Disallow: /sign-in",
          "Disallow: /sso-callback",
          "Disallow: /board",
          "Disallow: /api/",
          "",
          `Sitemap: ${SITE_URL}/sitemap.xml`,
        ];
  return new Response(lines.join("\n") + "\n", {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" },
  });
}
