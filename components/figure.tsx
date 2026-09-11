"use client";

import { useRef } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { cn } from "@/lib/utils";

/**
 * A rupee figure that counts to its new value rather than swapping.
 *
 * Whole rupees stay whole while counting — GSAP's `snap` keeps every frame on
 * an integer — and paise, when the amount has them, are shown small and
 * counted too. The earlier version rounded every value to a rupee and then
 * appended a decorative ".00", which is the opposite of a figure you can
 * check against a rate card.
 */
export function Figure({
  value,
  className,
  prefix = "₹",
}: {
  value: number;
  className?: string;
  prefix?: string;
}) {
  const wholeRef = useRef<HTMLSpanElement>(null);
  const paiseRef = useRef<HTMLSpanElement>(null);
  const shown = useRef(value);

  useGSAP(
    () => {
      const obj = { n: shown.current };
      gsap.to(obj, {
        n: value,
        duration: 0.5,
        ease: "power2.out",
        // Count in paise, never through fractions of a paisa.
        snap: { n: 0.01 },
        overwrite: true,
        onUpdate: () => {
          shown.current = obj.n;
          const { whole, paise } = split(obj.n);
          if (wholeRef.current) wholeRef.current.textContent = whole;
          if (paiseRef.current) paiseRef.current.textContent = paise;
        },
      });
    },
    { dependencies: [value] },
  );

  const initial = split(value);

  return (
    <span className={cn("font-figure flex items-baseline justify-center leading-none", className)}>
      {prefix}
      <span ref={wholeRef}>{initial.whole}</span>
      <span ref={paiseRef} className="text-[0.52em] tracking-[-0.02em]">
        {initial.paise}
      </span>
    </span>
  );
}

/** "₹64.20" → whole "64", paise ".20"; "₹5" → whole "5", paise "". */
function split(n: number): { whole: string; paise: string } {
  const cents = Math.round(n * 100);
  const whole = Math.floor(cents / 100);
  const rest = cents - whole * 100;
  return {
    whole: whole.toLocaleString("en-IN"),
    paise: rest === 0 ? "" : `.${String(rest).padStart(2, "0")}`,
  };
}
