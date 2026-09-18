/**
 * What search engines are told about the site, in one place.
 *
 * The product is Printifi — spelled the way the address is, printifi.store,
 * because that is what a student types after reading a standee. It was
 * "Printify" for a while, which is also a registered trademark of an
 * unrelated print-on-demand company; that spelling stays only as the
 * alternate name in the structured data, so anyone who remembers it still
 * finds the site. Every value here is a fact about the deployment, read
 * from the same variables the middleware routes by.
 */

const clean = (value: string | undefined) => (value ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
// The same derivation as lib/surface.ts hostsFrom: the site host, or the
// desk host with its `desk.` taken off (production sets only the desk's);
// on a bare localhost, the production address, so a sitemap or a canonical
// drawn locally still names the real site.
const deskEnv = clean(process.env.NEXT_PUBLIC_DESK_HOST);
const host = clean(process.env.NEXT_PUBLIC_SITE_HOST) || (deskEnv.startsWith("desk.") ? deskEnv.slice("desk.".length) : "") || "printifi.store";
const deskHost = deskEnv || `desk.${host}`;

export const SITE_HOST = host;
export const SITE_URL = `https://${host}`;
export const DESK_URL = `https://${deskHost}`;

export const BRAND = "Printifi";
/** The earlier spelling, kept as an alternate name so a search for it still lands here. */
export const BRAND_ALT = "Printify";
export const TAGLINE = "Upload from your phone, pay with UPI, collect a printed set. Campus printing without the queue.";

/** The day the policy pages last changed (ISO). Bump it when their words do. */
export const POLICIES_UPDATED = "2026-09-18";
/** The same day as people read it. */
export const POLICIES_UPDATED_LABEL = new Date(`${POLICIES_UPDATED}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/**
 * The pages worth a place in the index, with the canonical address of each.
 * A page carries a last-modified date only when one is known: the policies
 * have theirs, the home page is an app whose words change with the code.
 */
export const PUBLIC_PAGES: { path: string; priority: number; changeFrequency: "weekly" | "monthly"; lastModified?: string }[] = [
  { path: "/", priority: 1, changeFrequency: "weekly" },
  { path: "/refunds", priority: 0.5, changeFrequency: "monthly", lastModified: POLICIES_UPDATED },
  { path: "/desk-terms", priority: 0.5, changeFrequency: "monthly", lastModified: POLICIES_UPDATED },
  { path: "/terms", priority: 0.4, changeFrequency: "monthly", lastModified: POLICIES_UPDATED },
  { path: "/privacy", priority: 0.4, changeFrequency: "monthly", lastModified: POLICIES_UPDATED },
];

export const canonical = (path: string) => `${SITE_URL}${path === "/" ? "" : path}`;

/** Pages that are somebody's own — never in an index. */
export const NOINDEX = { index: false, follow: false } as const;
