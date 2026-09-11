import { cn } from "@/lib/utils";

/** One measure for the whole app so every section lines up edge to edge. */
export function Container({ className, children }: React.ComponentProps<"div">) {
  return (
    <div className={cn("mx-auto w-full max-w-[1180px] px-4 sm:px-6 lg:px-8", className)}>
      {children}
    </div>
  );
}
