/**
 * Two sites, one codebase.
 *
 * Students use `printifi.store`; the desk uses `desk.printifi.store`. One
 * database; the host (or a pinned deployment) decides which site a request
 * gets, and the middleware refuses the other one's pages. Deployed twice
 * with two Clerk applications — the intended production shape — a student
 * account and a desk account are different accounts, and signing in on one
 * site says nothing to the other. What anyone can *do* is still decided by
 * RLS, which only ever sees a `sub`.
 *
 * With no desk host configured (a bare `localhost:3000`, or a preview URL)
 * both sites share one host and the desk lives under `/operator` — the
 * "single" mode below. Nothing about the pages changes between modes; only
 * where they are addressed from.
 *
 * Pure functions, no `window`, no `process` — the middleware, the server
 * layout and the browser all call the same ones, and `check:features`
 * exercises the whole table.
 */

export type Surface = "student" | "desk";

export interface Hosts {
  /** e.g. `desk.printifi.store`. Empty means single-host mode. */
  desk: string;
  /** e.g. `printifi.store`. Derived from `desk` when not given. */
  student: string;
}

/** Reads the two hosts from environment values; empty strings mean unset. */
export function hostsFrom(env: { desk?: string; student?: string }): Hosts {
  const desk = clean(env.desk);
  const student = clean(env.student) || (desk.startsWith("desk.") ? desk.slice("desk.".length) : "");
  return { desk, student };
}

function clean(value: string | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
}

/** Single-host mode: no desk host configured, everything lives on one origin. */
export function isSingleHost(hosts: Hosts): boolean {
  return hosts.desk === "";
}

/**
 * Which site a request host belongs to.
 *
 * A deployment can pin itself with `pinned` ("desk" or "student"): the desk
 * deployed on its own with its own Clerk application is the desk on every
 * host it answers on, preview URLs included. Otherwise the host decides,
 * and `desk.localhost:3000` counts as the desk in single-host mode too, so
 * a developer can see both sites without touching the environment.
 */
export function surfaceFor(
  host: string | null | undefined,
  hosts: Hosts,
  pinned?: string | null,
): Surface {
  if (pinned === "desk" || pinned === "student") return pinned;
  const h = clean(host ?? "");
  if (!h) return "student";
  if (hosts.desk && h === hosts.desk) return "desk";
  if (h === "desk.localhost" || h.startsWith("desk.localhost:")) return "desk";
  return "student";
}

/** The desk's pages, by their internal (single-host) path prefix. */
const DESK_PREFIXES = ["/operator", "/join", "/admin", "/diagnostics"];
/** The student's pages. `/` is handled on its own. */
const STUDENT_PREFIXES = ["/orders", "/profile", "/settings"];
/** Pages both sites have, each rendering its own version. */
const SHARED_PREFIXES = ["/sign-in", "/sso-callback", "/api", "/manifest.webmanifest", "/desk.webmanifest"];

const under = (path: string, prefix: string) => path === prefix || path.startsWith(prefix + "/");

export type Routing =
  | { kind: "pass" }
  | { kind: "rewrite"; to: string }
  | { kind: "redirect"; to: string; host?: "student" | "desk" };

/**
 * What the middleware does with a path on a given site.
 *
 * Desk site: `/` is the queue and `/takings`, `/settings` are its faces — all
 * rewritten onto the internal `/operator/...` pages so the browser URL stays
 * short. A student page is sent to the student site; an internal
 * `/operator/...` URL is redirected to its short form so there is one address
 * for everything.
 *
 * Student site: any desk page goes to the desk site, prefix stripped.
 *
 * Single host: nothing moves.
 */
export function routeFor(surface: Surface, path: string, hosts: Hosts): Routing {
  if (isSingleHost(hosts) && surface === "student") return { kind: "pass" };

  if (surface === "desk") {
    if (SHARED_PREFIXES.some((p) => under(path, p))) return { kind: "pass" };
    if (under(path, "/join") || under(path, "/admin") || under(path, "/diagnostics")) {
      return { kind: "pass" };
    }
    if (under(path, "/operator")) {
      const short = path.slice("/operator".length) || "/";
      return { kind: "redirect", to: short };
    }
    if (path === "/") return { kind: "rewrite", to: "/operator" };
    // `/settings` on the desk is the desk's settings, not the student's; the
    // other student pages belong to the student site — or, with no student
    // host to send them to, go to the queue rather than render a student
    // page under the desk's chrome.
    if (STUDENT_PREFIXES.some((p) => under(path, p)) && !under(path, "/settings")) {
      return isSingleHost(hosts) ? { kind: "redirect", to: "/" } : { kind: "redirect", to: path, host: "student" };
    }
    return { kind: "rewrite", to: "/operator" + path };
  }

  // Student site, hosts configured.
  if (under(path, "/operator")) {
    return { kind: "redirect", to: path.slice("/operator".length) || "/", host: "desk" };
  }
  if (DESK_PREFIXES.some((p) => under(path, p))) return { kind: "redirect", to: path, host: "desk" };
  return { kind: "pass" };
}

/**
 * The public address of a desk page, for links.
 *
 * On the desk site the short form; in single-host mode the `/operator/...`
 * form. Always a path — never a host — so a link is same-origin wherever it
 * is rendered.
 */
export function deskPath(surface: Surface, internal: string): string {
  if (surface !== "desk") return internal;
  if (!under(internal, "/operator")) return internal;
  return internal.slice("/operator".length) || "/";
}

/**
 * Is this browser path one of the desk's pages? Used by the chrome to pick a
 * dock. On the desk site every path is; on the student site (or a single
 * host) only `/operator/...` is.
 */
export function onDesk(surface: Surface, path: string): boolean {
  return surface === "desk" || under(path, "/operator");
}

/**
 * Only ever a path on this origin. Clerk hands back `redirect_url` after a
 * sign-in — as an absolute URL — and a push payload carries `url`; both are
 * trusted today, and neither should ever be able to send someone to another
 * site. An absolute URL is accepted only when `origin` is given and matches
 * it exactly, and then only its path and query survive.
 */
export function sameOriginPath(url: string | null | undefined, fallback: string, origin?: string): string {
  if (typeof url !== "string" || url === "") return fallback;
  if (origin && (url === origin || url.startsWith(origin + "/") || url.startsWith(origin + "?"))) {
    const rest = url.slice(origin.length);
    return rest === "" ? "/" : rest;
  }
  if (!url.startsWith("/") || url.startsWith("//") || url.startsWith("/\\")) return fallback;
  return url;
}
