import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { Bricolage_Grotesque, Instrument_Sans, DM_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { ThemeProvider } from "@/components/theme-provider";
import { AppChrome } from "@/components/app-chrome";
import { SupabaseBridge } from "@/components/supabase-bridge";
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

export const metadata: Metadata = {
  title: "Print Counter",
  description:
    "Upload from your phone, pay with UPI, collect a printed set. Campus printing without the queue.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "Print Counter" },
};

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
        <ClerkProvider nonce={nonce}>
          <ThemeProvider nonce={nonce}>
            <SupabaseBridge />
            <AppChrome>{children}</AppChrome>
          </ThemeProvider>
        </ClerkProvider>
      </body>
    </html>
  );
}
