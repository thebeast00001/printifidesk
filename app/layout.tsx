import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { Bricolage_Grotesque, Instrument_Sans, DM_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { ThemeProvider } from "@/components/theme-provider";
import { AppChrome } from "@/components/app-chrome";
import { SupabaseBridge } from "@/components/supabase-bridge";
import { SurfaceProvider } from "@/components/surface-provider";
import { HOSTS, requestSurface } from "@/lib/server/surface";
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
      title: { default: "Printify Desk", template: "%s · Printify Desk" },
      description: "The counter's side of Printify: the queue, the prices, the hours, the handover.",
      manifest: "/desk.webmanifest",
      appleWebApp: { capable: true, statusBarStyle: "default", title: "Printify Desk" },
    };
  }
  return {
    title: { default: "Printify", template: "%s · Printify" },
    description:
      "Upload from your phone, pay with UPI, collect a printed set. Campus printing without the queue.",
    manifest: "/manifest.webmanifest",
    appleWebApp: { capable: true, statusBarStyle: "default", title: "Printify" },
  };
}

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
