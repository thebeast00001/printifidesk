import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

/**
 * Browsing is public — you can see the counter's wait and the upload card
 * without an account. Anything that reads or writes your own rows needs one.
 */
const isProtected = createRouteMatcher([
  "/orders(.*)",
  "/profile(.*)",
  "/diagnostics(.*)",
  "/admin(.*)",
]);

// /operator is deliberately not in that list. A paired desk device opens it
// signed out and sees the tap-a-name screen; everything on the page is
// behind RLS, so an unpaired, signed-out visitor sees a sign-in and nothing
// else. Redirecting to Clerk's hosted sign-in would defeat the point.

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
    if (isProtected(request)) await auth.protect();
  },
  {
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
        "form-action": ["'self'"],
        "manifest-src": ["'self'"],
        // next/font serves every face from this origin.
        "font-src": ["'self'"],
        // Thumbnails are object URLs from pdf.js; the UPI QR is a data URL.
        "img-src": ["'self'", "blob:", "data:", "https://img.clerk.com"],
        // pdf.js runs as a module worker from /pdf.worker.min.mjs.
        "worker-src": ["'self'", "blob:"],
        "style-src": ["'self'", "'unsafe-inline'"],
        // PostgREST, storage and realtime all sit on the one Supabase origin.
        "connect-src": ["'self'", supabaseOrigin, supabaseSocket],
        // Clerk's bot check renders in a Cloudflare iframe; nothing else does.
        "frame-src": ["'self'", "https://challenges.cloudflare.com"],
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
