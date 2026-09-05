/**
 * Whether Dispatcher is the window you are actually looking at.
 *
 * `document.hasFocus()` answers for the webview, not for the application, and
 * in a Tauri window it can keep reporting true while the app sits behind
 * something else. `dockAttention` already worked around that for its repeat
 * loop; everywhere else took the webview's word for it.
 *
 * That mattered more than it sounds. Acknowledgement — "you have already seen
 * this tab, so do not interrupt you about it" — is refreshed while a tab is
 * active and the app is focused. With focus stuck true, the tab you left open
 * was continuously marked as seen while you were somewhere else entirely, so
 * it never became stale, never chimed, and never pushed.
 *
 * The window's own focus state is authoritative but only available
 * asynchronously, so it is tracked here and read synchronously by callers that
 * cannot await.
 */

import { getCurrentWindow } from "@tauri-apps/api/window";
import { debugLog } from "./debugLog";
import { isReplicaClient } from "./replication";

let windowFocused: boolean | null = null;
let started = false;

/**
 * Begin tracking. Safe to call more than once; only the desktop has a window
 * to ask about, so a replica keeps using the document's answer, which is
 * correct there — a browser tab's focus really is the page's focus.
 */
export function startAppFocusTracking(): void {
  if (started || isReplicaClient()) {
    return;
  }
  started = true;

  const win = getCurrentWindow();
  void win
    .isFocused()
    .then((focused) => {
      // Do not clobber a change that arrived while this was in flight.
      if (windowFocused === null) {
        windowFocused = focused;
      }
    })
    .catch(() => {});

  void win
    .onFocusChanged(({ payload }) => {
      if (windowFocused !== payload) {
        debugLog("app.runtime", "app focus changed", {
          focused: payload,
          documentSays: typeof document !== "undefined" ? document.hasFocus() : null,
        });
      }
      windowFocused = payload;
    })
    .catch(() => {});
}

/**
 * True when the app is frontmost.
 *
 * Falls back to the document while the window's state is still unknown, and on
 * a replica where it is the right answer anyway.
 */
export function isAppFocused(): boolean {
  if (windowFocused !== null) {
    return windowFocused;
  }
  return typeof document !== "undefined" ? document.hasFocus() : false;
}
