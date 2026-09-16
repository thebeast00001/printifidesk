import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { Bricolage_Grotesque, Instrument_Sans, DM_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { ThemeProvider } from "@/components/theme-provider";
import { AppChrome } from "@/components/app-chrome";
import { SupabaseBridge } from "@/components/supabase-bridge";
import { SurfaceProvider } from "@/components/surface-provider";
import { PARKED, PARKED_EVENT } from "@/lib/install-names";
import { HOSTS, requestSurface } from "@/lib/server/surface";
import { BRAND, BRAND_ALT, DESK_URL, NOINDEX, SITE_HOST, SITE_URL, TAGLINE } from "@/lib/seo";
import { isSingleHost } from "@/lib/surface";
import "./globals.css";

/* Display face: the width + optical-size axes are what give the widget
   numerals their tight, slightly condensed cut. */
const bricolage = Bricolage_Grotesque({
  subsets: ["latin"],
  axes: ["opsz", "wdth"],
  variable: "--font-bricolage",
  display: "swap",
});

const instrument = Instrument_Sans({
  subsets: ["latin"],
  variable: "--font-instrument",
  display: "swap",
});

const dmMono = DM_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-dm-mono",
  display: "swap",
});

/**
 * Two sites, two names. The desk installs as its own app, with its own
 * manifest and icon, so a tablet at the counter doesn't open to an upload
 * card.
 */
export async function generateMetadata(): Promise<Metadata> {
  const surface = await requestSurface();
  if (surface === "desk") {
    return {
      metadataBase: new URL(DESK_URL),
      title: { default: "Printify Desk", template: "%s · Printify Desk" },
      description: "The counter's side of Printify: the queue, the prices, the hours, the handover.",
      manifest: "/desk.webmanifest",
      icons: {
        icon: [
          { url: "/desk-favicon.ico", sizes: "48x48" },
          { url: "/desk-icon-192.png", sizes: "192x192", type: "image/png" },
        ],
        apple: "/desk-icon-192.png",
      },
      appleWebApp: { capable: true, statusBarStyle: "default", title: "Printify Desk" },
      // A tool for people who already have it: out of every index. Its
      // copies of the legal pages point their canonical at the student site.
      robots: NOINDEX,
    };
  }
  return {
    metadataBase: new URL(SITE_URL),
    applicationName: BRAND,
    title: { default: `${BRAND} — print from your phone, collect at the desk`, template: `%s · ${BRAND}` },
    description: TAGLINE,
    keywords: [BRAND, BRAND_ALT, SITE_HOST, "campus printing", "print from phone", "print shop near me", "UPI printing", "college printout"],
    manifest: "/manifest.webmanifest",
    // Two icons, both named with their size: the .ico a search result shows
    // (Google wants a multiple of 48 px, and fetches /favicon.ico by default
    // wherever a page doesn't say), and the PNG a tab or an install uses.
    // apple-touch-icon: without it iOS puts a screenshot of the page on the
    // home screen instead of the icon.
    icons: {
      icon: [
        { url: "/favicon.ico", sizes: "48x48" },
        { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      ],
      apple: "/icon-192.png",
    },
    appleWebApp: { capable: true, statusBarStyle: "default", title: BRAND },
    // What a shared link unfurls into. The image is drawn by opengraph-image.tsx.
    openGraph: { type: "website", siteName: BRAND, url: SITE_URL, title: `${BRAND} — print from your phone, collect at the desk`, description: TAGLINE, locale: "en_IN" },
    twitter: { card: "summary_large_image", title: `${BRAND} — print from your phone, collect at the desk`, description: TAGLINE },
    robots: { index: true, follow: true },
  };
}

/**
 * Who this site is, for the machines that draw a result: the organisation,
 * its two spellings — the name on the page and the name in the address —
 * and the site itself. Facts only; no ratings, no invented offices.
 */
const STRUCTURED_DATA = JSON.stringify([
  {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": `${SITE_URL}/#organization`,
    name: BRAND,
    alternateName: [BRAND_ALT, SITE_HOST],
    url: SITE_URL,
    logo: `${SITE_URL}/icon-512.png`,
    description: TAGLINE,
    areaServed: "IN",
  },
  {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": `${SITE_URL}/#website`,
    name: BRAND,
    alternateName: BRAND_ALT,
    url: SITE_URL,
    publisher: { "@id": `${SITE_URL}/#organization` },
    inLanguage: "en-IN",
  },
  {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: BRAND,
    url: SITE_URL,
    applicationCategory: "UtilitiesApplication",
    operatingSystem: "Any",
    description: TAGLINE,
    offers: { "@type": "Offer", price: "0", priceCurrency: "INR", description: "Free to use; you pay the print desk for what it prints." },
  },
]);

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#edebe6" },
    { media: "(prefers-color-scheme: dark)", color: "#131316" },
  ],
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
};

// Kept as one line of plain script so it runs before anything else loads.
const PARK_INSTALL_PROMPT =
  `window.addEventListener("beforeinstallprompt",function(e){e.preventDefault();` +
  `window.${PARKED}=e;window.dispatchEvent(new Event("${PARKED_EVENT}"))});`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The CSP nonce Clerk's middleware minted for this request. Reading headers
  // makes the layout dynamic, which is right: the nonce is different every
  // time, so a prerendered shell could never carry a valid one.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const surface = await requestSurface();
  const split = !isSingleHost(HOSTS);

  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${bricolage.variable} ${instrument.variable} ${dmMono.variable}`}
    >
      {/* suppressHydrationWarning on <body>, not just <html>: browser
          extensions (ColorZilla stamps `cz-shortcut-listen`, Grammarly and
          password managers do similar) add attributes to the body before
          React hydrates, and React reports the difference as our bug. It is
          scoped to this one element's attributes — children still hydrate
          strictly. */}
      <body suppressHydrationWarning>
        {/* Chrome's install event can fire before React has hydrated. Park it
            here and stop the browser's own bar; lib/install.ts picks it up. */}
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: PARK_INSTALL_PROMPT }} />
        {surface === "student" && (
          <script nonce={nonce} type="application/ld+json" dangerouslySetInnerHTML={{ __html: STRUCTURED_DATA }} />
        )}
        {/* Both providers inject a script tag; both need this request's nonce
            or the strict CSP blocks them. */}
        <ClerkProvider
          nonce={nonce}
          signInUrl="/sign-in"
          signUpUrl="/sign-in"
          // Signing out of the desk lands on the desk's door, not a student home.
          afterSignOutUrl={surface === "desk" ? "/sign-in" : "/"}
        >
          <ThemeProvider nonce={nonce}>
            <SurfaceProvider surface={surface} split={split}>
              <SupabaseBridge />
              <AppChrome>{children}</AppChrome>
            </SurfaceProvider>
          </ThemeProvider>
        </ClerkProvider>
      </body>
    </html>
  );
}
