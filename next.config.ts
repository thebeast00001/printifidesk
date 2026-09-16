import type { NextConfig } from "next";

/**
 * Response headers that don't depend on the request.
 *
 * The Content-Security-Policy is not here — it carries a per-request nonce,
 * so it lives in proxy.ts where Clerk's middleware generates it.
 */
const securityHeaders = [
  // Browsers must not guess a content type — a file uploaded as a "PDF" that
  // is really HTML must never be rendered as HTML.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Belt and braces with CSP's frame-ancestors, for browsers that predate it.
  { key: "X-Frame-Options", value: "DENY" },
  // Never leak the page URL (which can carry an order id) to other origins.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // The camera is used for scanning; nothing here needs the rest.
  {
    key: "Permissions-Policy",
    value: "camera=(self), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  },
  // Once a browser has seen this over HTTPS it refuses plain HTTP for a year.
  // Only sent in production: on localhost it would pin the dev port to TLS.
  ...(process.env.NODE_ENV === "production"
    ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }]
    : []),
  // Nobody else's window gets a handle on ours. `allow-popups` rather than
  // plain `same-origin` because Clerk's Google sign-in opens one and needs to
  // report back through it.
  { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
  // Our own responses can't be embedded by other origins. No COEP: that would
  // block Clerk's avatars and its bot-check iframe, neither of which we control.
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
];

/**
 * The site's one address. `www.` answered with the same pages, and Google
 * indexed that copy as the original — a second address for the same site
 * splits its standing between the two. Sent home for good (308) so there is
 * one. The host is found the way the middleware finds it (lib/surface.ts
 * hostsFrom): NEXT_PUBLIC_SITE_HOST, or the desk host with its `desk.`
 * taken off. Neither set — a bare localhost — nothing redirects.
 */
const cleanHost = (value: string | undefined) =>
  (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
const deskHost = cleanHost(process.env.NEXT_PUBLIC_DESK_HOST);
const siteHost = cleanHost(process.env.NEXT_PUBLIC_SITE_HOST) || (deskHost.startsWith("desk.") ? deskHost.slice("desk.".length) : "");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // No reason to announce the framework in every response.
  poweredByHeader: false,
  /* Pin the workspace root. There is a stray package.json in the home
     directory above this one, and Turbopack would otherwise infer that as
     the root and pull the whole home folder into the build graph. */
  turbopack: { root: __dirname },
  experimental: {
    optimizePackageImports: ["lucide-react", "motion"],
  },
  async redirects() {
    if (!siteHost) return [];
    return [
      {
        source: "/:path*",
        has: [{ type: "host", value: `www.${siteHost}` }],
        destination: `https://${siteHost}/:path*`,
        permanent: true,
      },
    ];
  },
  async headers() {
    return [
      { source: "/(.*)", headers: securityHeaders },
      // The service worker must be picked up promptly when it changes, and
      // must only ever control this origin.
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};

export default nextConfig;
