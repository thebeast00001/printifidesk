"use client";

import { ThemeProvider as NextThemes } from "next-themes";

/**
 * `nonce` is the per-request CSP nonce from proxy.ts. next-themes injects one
 * inline script to set the colour scheme before the first paint; without the
 * nonce, a strict policy would block it and the page would flash the wrong
 * theme on every load.
 */
export function ThemeProvider({ children, nonce }: { children: React.ReactNode; nonce?: string }) {
  return (
    <NextThemes
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      nonce={nonce}
    >
      {children}
    </NextThemes>
  );
}
