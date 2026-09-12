"use client";

import { FloatingDock } from "./floating-dock";
import { PrintSheet } from "./print-sheet";
import { SearchDialog } from "./search-dialog";
import { InstallDrawer } from "./install-app";
import { SavingsBreakdown } from "./savings-breakdown";
import { PageReview } from "./page-review";

/**
 * Everything that persists across routes: the page ground, the floating nav,
 * and the print sheet (which can be opened from any page).
 */
export function AppChrome({ children }: { children: React.ReactNode }) {
  return (
    <>
      <div className="min-h-dvh bg-paper pb-32">{children}</div>
      <FloatingDock />
      <PrintSheet />
      <SearchDialog />
      <SavingsBreakdown />
      <InstallDrawer />
      <PageReview />
    </>
  );
}
