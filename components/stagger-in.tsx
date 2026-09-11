"use client";

import { useRef } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";

/**
 * One orchestrated entrance per page rather than every component animating
 * itself — GSAP's stagger stays honest as sections are added or reordered.
 *
 * Skipped when the tab isn't painting: rAF stalls in a background tab, and a
 * frozen `from` tween would leave the page blank until it regains focus.
 */
export function StaggerIn({ children }: { children: React.ReactNode }) {
  const scope = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      if (document.visibilityState !== "visible") return;
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      gsap.from("[data-anim]", {
        opacity: 0,
        y: 16,
        duration: 0.62,
        ease: "power3.out",
        stagger: 0.075,
        clearProps: "opacity,transform",
      });
    },
    { scope },
  );

  return <div ref={scope}>{children}</div>;
}
