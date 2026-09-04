/**
 * Service worker for Dispatcher's home-screen web app.
 *
 * Its only job is push. Nothing here caches anything: Dispatcher is useless
 * without a live connection to the desktop, so serving a stale shell offline
 * would show a terminal that cannot possibly be current — worse than failing
 * to load.
 *
 * A service worker is required even so, because on iOS a push can only be
 * delivered to one. It is the only part of the app that runs when the web app
 * is closed, which is the entire point: the sound and the dock bounce cannot
 * reach someone whose laptop is shut.
 */

// Take over without waiting for the old worker's clients to go away. There is
// no cached state to migrate, and a push handler a version behind is worse
// than a brief overlap.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

/**
 * iOS requires a visible notification for every push. Failing to show one
 * counts against the app and eventually the subscription is dropped, so the
 * fallback text matters: it is what appears if the payload is ever missing or
 * malformed, and showing something vague is better than showing nothing.
 */
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }

  const title = payload.title || "Dispatcher";
  const body = payload.body || "A terminal needs your attention.";

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/icons/icon-256.png",
      badge: "/icons/icon-128.png",
      // Collapse repeats for the same tab rather than stacking a notification
      // per sample; the terminal id is stable and that is what identity means
      // here.
      tag: payload.terminalId || "dispatcher",
      renotify: Boolean(payload.terminalId),
      data: { terminalId: payload.terminalId || null },
    })
  );
});

/**
 * Focus an already-open window rather than opening a second copy, and ask it
 * to switch to the tab the notification was about.
 */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const terminalId = event.notification.data && event.notification.data.terminalId;

  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of all) {
        if ("focus" in client) {
          await client.focus();
          if (terminalId) {
            client.postMessage({ type: "dispatcher:focus-terminal", terminalId });
          }
          return;
        }
      }
      if (self.clients.openWindow) {
        await self.clients.openWindow("/");
      }
    })()
  );
});
