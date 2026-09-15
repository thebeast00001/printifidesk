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
  return surfaceFor(h.get("x-forwarded-host") ?? h.get("host"), HOSTS, process.env.NEXT_PUBLIC_SURFACE);
}

/**
 * The host this request arrived on, lower-cased, without a port on the
 * standard ones. `x-forwarded-host` is what the browser typed when a proxy
 * sits in front (Vercel sets it and overwrites whatever the client sent).
 */
export async function requestHost(): Promise<string> {
  const h = await headers();
  return (h.get("x-forwarded-host") ?? h.get("host") ?? "").trim().toLowerCase().replace(/:(80|443)$/, "");
}

/**
 * `https://desk.printifi.store` — scheme and host of this request, no path.
 *
 * Only ever one of the configured hosts. This origin becomes the return
 * and webhook URLs handed to the payment partner, so a request arriving
 * under a host that isn't ours (a poisoned Host header at some proxy, a
 * preview alias) must not be able to point those anywhere else: it gets
 * the student site's origin instead. With no hosts configured — a bare
 * localhost — the request's own host is the only thing there is.
 */
export async function requestOrigin(): Promise<string> {
  const host = await requestHost();
  const known = [HOSTS.student, HOSTS.desk].filter(Boolean);
  const chosen = known.length === 0 ? host : known.includes(host) ? host : (HOSTS.student || HOSTS.desk);
  const h = await headers();
  const local = chosen.startsWith("localhost") || chosen.includes(".localhost");
  const proto = local ? (h.get("x-forwarded-proto") ?? "http") : "https";
  return `${proto}://${chosen}`;
}

/**
 * Was this request sent by a page of ours? For routes that act on the
 * signed-in cookie: a cross-site page can't read the reply, but with the
 * cookie along it could make the request — this refuses that. Browsers put
 * `Origin` on every POST and DELETE; a request without one is not a page
 * of ours. The two sites are two origins, and each may only call its own.
 */
export async function sameOriginRequest(request: Request): Promise<boolean> {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase().replace(/:(80|443)$/, "");
  } catch {
    return false;
  }
  return originHost === (await requestHost());
}
