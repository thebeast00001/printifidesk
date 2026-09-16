/**
 * What search engines are told about the site, in one place.
 *
 * The product is called Printify and lives at printifi.store — two
 * spellings, and the second is the one people type into a search box after
 * seeing the address on a standee. So the site carries both: the name on
 * every page, the domain spelling as the alternate name in the structured
 * data and in the footer. Every value here is a fact about the deployment,
 * read from the same variables the middleware routes by.
 */

const host = (process.env.NEXT_PUBLIC_SITE_HOST ?? "printifi.store").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
const deskHost = (process.env.NEXT_PUBLIC_DESK_HOST ?? `desk.${host}`).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");

export const SITE_HOST = host;
export const SITE_URL = `https://${host}`;
export const DESK_URL = `https://${deskHost}`;

export const BRAND = "Printify";
/** The domain's spelling — what a student types after reading a standee. */
export const BRAND_ALT = "Printifi";
export const TAGLINE = "Upload from your phone, pay with UPI, collect a printed set. Campus printing without the queue.";

/** The day the policy pages last changed (ISO). Bump it when their words do. */
export const POLICIES_UPDATED = "2026-09-16";
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
