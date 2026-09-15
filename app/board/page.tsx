import type { Metadata } from "next";
import { Suspense } from "react";
import { Board } from "@/components/board";

export const metadata: Metadata = {
  title: "Board",
  description: "Tokens in the queue, printing and ready — the screen at the counter.",
  robots: { index: false },
};

/**
 * The counter screen: /board?desk=<id>. A TV or a spare phone at the shop
 * points here and leaves it. Tokens only; nothing a stranger could use.
 */
export default function BoardPage() {
  return (
    <Suspense fallback={null}>
      <Board />
    </Suspense>
  );
}
