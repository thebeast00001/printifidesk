import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { hostsFrom, routeFor, surfaceFor } from "@/lib/surface";

/**
 * Browsing is public — you can see the counter's wait and the upload card
 * without an account. Anything that reads or writes your own rows needs one.
 *
 * `/operator` is deliberately not in this list. A paired desk device opens
 * it signed out and sees the tap-a-name screen; everything on the page is
 * behind RLS, so an unpaired, signed-out visitor sees a sign-in and nothing
 * else. Sending them to a hosted sign-in would defeat the point.
 */
const isProtected = createRouteMatcher([
  "/orders(.*)",
  "/receipt(.*)",
  "/profile(.*)",
  "/diagnostics(.*)",
  "/admin(.*)",
]);

/**
 * Two sites on one deployment: the host picks the site, the table in
 * lib/surface.ts says what each site does with each path. Empty when both
 * live on one host, which is how a bare `localhost` runs.
 */
const HOSTS = hostsFrom({
  desk: process.env.NEXT_PUBLIC_DESK_HOST,
  student: process.env.NEXT_PUBLIC_SITE_HOST,
});

/**
 * Every host the page is allowed to talk to, and nothing else.
 *
 * Supabase is the only origin outside Clerk's own list. It's read from the
 * environment rather than typed here so the policy can't silently drift from
 * the project the app is actually pointed at.
 */
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const supabaseOrigin = supabaseUrl.replace(/\/$/, "");
const supabaseSocket = supabaseOrigin.replace(/^https:/, "wss:");

export default clerkMiddleware(
  async (auth, request) => {
    // The notification and purge endpoints are called by Postgres and a
    // scheduler, not a signed-in browser; they authenticate with their own
    // shared secret, compared in constant time.
    if (request.nextUrl.pathname.startsWith("/api/")) return;

    const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
    const surface = surfaceFor(host, HOSTS, process.env.NEXT_PUBLIC_SURFACE);
    const route = routeFor(surface, request.nextUrl.pathname, HOSTS);

    if (route.kind === "redirect") {
      // Built from the request's own host, not `nextUrl`'s — behind a proxy
      // (and in dev) that is the bind address, not what the browser typed.
      // The search string travels with it so a join link or a sign-in return
      // address survives the hop.
      const proto = request.headers.get("x-forwarded-proto") ?? request.nextUrl.protocol.replace(":", "");
      const target = route.host ? (route.host === "desk" ? HOSTS.desk : HOSTS.student) : host;
      return NextResponse.redirect(`${proto}://${target}${route.to}${request.nextUrl.search}`, 307);
    }

    if (isProtected(request)) await auth.protect();

    if (route.kind === "rewrite") {
      const url = request.nextUrl.clone();
      url.pathname = route.to;
      return NextResponse.rewrite(url);
    }
  },
  {
    // Both sites have a `/sign-in`, each its own: the student's is one
    // Google button, the desk's is email and password. A protected page a
    // signed-out person lands on sends them there, and back afterwards.
    signInUrl: "/sign-in",
    signUpUrl: "/sign-in",

    /*
     * A strict, nonce-based Content Security Policy.
     *
     * `strict: true` gives every response a fresh nonce and `'strict-dynamic'`,
     * so only scripts the server rendered (and what they load) can run. An
     * injected `<script>` — from a filename, a note, a report — runs nothing,
     * even if some future template forgot to escape it. Clerk adds its own
     * origins and hands the nonce to Next through the `x-nonce` request header.
     *
     * Each entry below is a host the app really uses; the comment says where.
     * `'unsafe-inline'` on styles is the one concession: motion and GSAP write
     * inline `style=` attributes on every frame, and a style nonce can't cover
     * that. Inline styles cannot run script, so the cost is small.
     */
    contentSecurityPolicy: {
      strict: true,
      directives: {
        "default-src": ["'self'"],
        "base-uri": ["'self'"],
        "object-src": ["'none'"],
        // No one may frame this page — the token QR and the pay button are
        // exactly what a clickjacking overlay would target.
        "frame-ancestors": ["'none'"],
        // Cashfree's SDK opens its checkout by posting a form into its own
        // iframe (sandbox.cashfree.com / api.cashfree.com); with 'self' alone
        // the post is blocked and the modal stays blank forever.
        "form-action": ["'self'", "https://*.cashfree.com"],
        "manifest-src": ["'self'"],
        // next/font serves every face from this origin.
        "font-src": ["'self'"],
        // Thumbnails are object URLs from pdf.js; the UPI QR is a data URL.
        "img-src": ["'self'", "blob:", "data:", "https://img.clerk.com"],
        // pdf.js runs as a module worker from /pdf.worker.min.mjs.
        "worker-src": ["'self'", "blob:"],
        "style-src": ["'self'", "'unsafe-inline'"],
        // PostgREST, storage and realtime all sit on the one Supabase origin.
        // Cashfree's SDK talks to its own API from the page.
        "connect-src": ["'self'", supabaseOrigin, supabaseSocket, "https://*.cashfree.com"],
        // Clerk's bot check renders in a Cloudflare iframe; Cashfree's
        // checkout is an iframe on cashfree.com. Nothing else is framed.
        "frame-src": ["'self'", "https://challenges.cloudflare.com", "https://*.cashfree.com"],
        ...(process.env.NODE_ENV === "production" ? { "upgrade-insecure-requests": [] } : {}),
      },
    },
  },
);

export const config = {
  matcher: [
    // Everything except Next internals and static files, unless in a search param.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest|mjs)).*)",
    "/(api|trpc)(.*)",
  ],
};
