"use client";

import { createContext, useContext } from "react";
import { deskPath, onDesk, type Surface } from "@/lib/surface";

interface SurfaceValue {
  surface: Surface;
  /** Whether a desk host is configured at all — false on a bare localhost. */
  split: boolean;
}

const SurfaceContext = createContext<SurfaceValue>({ surface: "student", split: false });

/**
 * The site this page belongs to, decided on the server from the host and
 * handed down once, so server and client agree on the first paint.
 */
export function SurfaceProvider({
  surface,
  split,
  children,
}: SurfaceValue & { children: React.ReactNode }) {
  return <SurfaceContext.Provider value={{ surface, split }}>{children}</SurfaceContext.Provider>;
}

export function useSurface(): SurfaceValue & {
  /** The public address of an internal desk path on this site. */
  desk: (internal: string) => string;
  /** Whether a browser path is one of the desk's pages here. */
  isDeskPath: (path: string) => boolean;
} {
  const value = useContext(SurfaceContext);
  return {
    ...value,
    desk: (internal) => deskPath(value.surface, internal),
    isDeskPath: (path) => onDesk(value.surface, path),
  };
}
