"use client";

import { useRef } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { cn } from "@/lib/utils";

/**
 * A rupee figure that counts to its new value rather than swapping.
 * GSAP's `snap` keeps every intermediate frame a whole rupee, so the digits
 * never flicker through fractions on the way.
 */
export function Figure({
  value,
  decimals,
  className,
  prefix = "₹",
}: {
  value: number;
  decimals?: boolean;
  className?: string;
  prefix?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef(value);

  useGSAP(
    () => {
      const obj = { n: shown.current };
      gsap.to(obj, {
        n: value,
        duration: 0.5,
        ease: "power2.out",
        snap: { n: 1 },
        overwrite: true,
        onUpdate: () => {
          shown.current = obj.n;
          if (ref.current) ref.current.textContent = Math.round(obj.n).toLocaleString("en-IN");
        },
      });
    },
    { dependencies: [value] },
  );

  return (
    <span className={cn("font-figure flex items-baseline justify-center leading-none", className)}>
      {prefix}
      <span ref={ref}>{value.toLocaleString("en-IN")}</span>
      {decimals && <span className="text-[0.52em] tracking-[-0.02em]">.00</span>}
    </span>
  );
}
