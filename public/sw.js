/**
 * Service worker — web push only.
 *
 * Deliberately does not cache anything: a print queue that serves a stale page
 * is worse than one that needs a network. Its whole job is receiving a push
 * when the tab is closed and taking the reader to the order.
 */

self.addEventListener("push", (event) => {
  if (!event.data) return;

  let payload = {};
  try {
    payload = event.data.json();
  } catch {
    payload = { title: "Printifi", body: event.data.text() };
  }

  event.waitUntil(
    self.registration.showNotification(payload.title || "Printifi", {
      body: payload.body || "",
      // The desk's pushes carry the desk's mark; anything else is the app's.
      icon: sameOriginPath(payload.icon, "/icon-192.png"),
      badge: sameOriginPath(payload.icon, "/icon-192.png"),
      // Same tag replaces an earlier notification for the same order rather
      // than stacking three of them as a job moves through the queue.
      tag: payload.tag || "printify-order",
      renotify: true,
      // The pattern the dispatcher chose: long for "ready", a tap otherwise.
      vibrate: Array.isArray(payload.vibrate) ? payload.vibrate : [40],
      data: { url: payload.url || "/orders" },
      requireInteraction: payload.requireInteraction === true,
    }),
  );
});

/**
 * Only ever navigate within this origin.
 *
 * The payload is signed by our own server, so `url` is trusted today — but a
 * service worker outlives the code that registered it, and a notification is
 * the one place a stray absolute URL would open a phishing page under our
 * name. A relative path is the only shape accepted.
 */
function sameOriginPath(url, fallback) {
  if (typeof url !== "string") return fallback;
  if (!url.startsWith("/") || url.startsWith("//") || url.startsWith("/\\")) return fallback;
  return url;
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  let target = sameOriginPath(event.notification.data && event.notification.data.url, "/orders");
  // On the desk's own host the queue is "/": "/operator" only redirects
  // there, and a navigation that starts with a redirect is what Chrome's
  // installed-app error page ("This page couldn't load") has been seen on.
  // Land on the page itself.
  const onDeskHost = self.location.hostname.startsWith("desk.");
  if (onDeskHost && (target === "/operator" || target.startsWith("/operator/"))) {
    target = target.slice("/operator".length) || "/";
  }

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      // Focus a window that's already open rather than piling up new ones.
      for (const client of clients) {
        if (client.url.includes(target) && "focus" in client) return client.focus();
      }
      // The desk's pages are live — any open window of the app already shows
      // the new order. Focusing it is enough, and never fails the way a
      // navigation from the background can.
      if (onDeskHost) {
        for (const client of clients) {
          if ("focus" in client) return client.focus();
        }
      }
      for (const client of clients) {
        if ("navigate" in client && "focus" in client) {
          return client
            .navigate(target)
            .then((c) => c && c.focus())
            // An uncontrolled or stale client refuses to navigate: focus it as it is.
            .catch(() => ("focus" in client ? client.focus() : undefined));
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
