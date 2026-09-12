/**
 * Shared between the root layout's inline script (server) and the install
 * store (client). Kept in a file with no "use client" directive: importing a
 * client module from a server component turns its exports into references,
 * and a reference stringified into a script tag is a syntax error.
 */

/** The window property the layout's inline script parks Chrome's install event under. */
export const PARKED = "__printifyInstallPrompt";
/** Dispatched on `window` by that script when it parks one. */
export const PARKED_EVENT = "printify:installable";
