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
  const body = payload.body || "A terminal is now inactive";

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
/**
 * Where a tapped notification leaves its terminal for the page to collect.
 *
 * postMessage alone is not enough. On iOS a home-screen web app is frozen
 * while backgrounded; `client.focus()` thaws it, but the page's listeners are
 * not back yet, and a message posted into that gap is dropped with nothing to
 * carry the terminal instead -- the app comes to the front on whatever tab it
 * was already showing. A cache entry survives the gap, and survives this
 * worker being killed between the tap and the page waking up.
 */
const PENDING_FOCUS_CACHE = "dispatcher-pending-focus";
const PENDING_FOCUS_URL = "/__dispatcher_pending_focus";

async function rememberPendingFocus(terminalId) {
  try {
    const cache = await caches.open(PENDING_FOCUS_CACHE);
    await cache.put(PENDING_FOCUS_URL, new Response(terminalId));
  } catch (error) {
    // The message below is still worth trying.
  }
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const terminalId = event.notification.data && event.notification.data.terminalId;

  event.waitUntil(
    (async () => {
      // Written before anything is focused, so the page finds it however it
      // wakes up -- and whether or not the message below survives.
      if (terminalId) {
        await rememberPendingFocus(terminalId);
      }

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
        // Nothing is running to receive a message, so the terminal travels in
        // the URL. The app strips the parameter once it has acted on it.
        const target = terminalId
          ? `/?terminal=${encodeURIComponent(terminalId)}`
          : "/";
        await self.clients.openWindow(target);
      }
    })()
  );
});
