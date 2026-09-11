import "server-only";
import { headers } from "next/headers";
import { hostsFrom, surfaceFor, type Hosts, type Surface } from "@/lib/surface";

/** The same two hosts the middleware reads. */
export const HOSTS: Hosts = hostsFrom({
  desk: process.env.NEXT_PUBLIC_DESK_HOST,
  student: process.env.NEXT_PUBLIC_SITE_HOST,
});

/**
 * Which site this request is for, decided the same way the middleware
 * decided it: from the host. Reading headers makes the caller dynamic, which
 * the root layout already is for the CSP nonce.
 */
export async function requestSurface(): Promise<Surface> {
  const h = await headers();
  return surfaceFor(h.get("x-forwarded-host") ?? h.get("host"), HOSTS);
}

/** `https://desk.printify.app` — scheme and host of this request, no path. */
export async function requestOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.includes(".localhost") ? "http" : "https");
  return `${proto}://${host}`;
}
