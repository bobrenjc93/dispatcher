/**
 * Dock bouncing for tabs the user asked to be pulled back to.
 *
 * Distinct from "Notify on Inaction", which fires a sound once a tab has been
 * quiet for a while. This fires on the moment a tab *starts* needing
 * attention, which is the state the status dot already tracks, and it keeps
 * bouncing until the user activates Dispatcher.
 */

import { getCurrentWindow } from "@tauri-apps/api/window";
import { cancelDockAttention, pulseDockAttention } from "./tauriCommands";
import { debugLog } from "./debugLog";
import { isAppFocused } from "./appFocus";

/**
 * Bounce only on the transition into needing attention.
 *
 * Testing the edge rather than the level matters twice over: a tab that is
 * already asking for attention must not re-bounce on every sample, and turning
 * the option on for such a tab must not bounce retroactively — the user is
 * looking at it right then.
 */
export function shouldBounceDock(args: {
  enabled: boolean;
  wasNeedsAttention: boolean;
  nextNeedsAttention: boolean;
  documentHasFocus: boolean;
}): boolean {
  if (!args.enabled || !args.nextNeedsAttention || args.wasNeedsAttention) {
    return false;
  }
  // A bounce exists to pull someone back from another app. With Dispatcher in
  // front of them there is nothing to pull them back from, whichever tab they
  // happen to be reading — the sidebar dot already says a background tab wants
  // looking at.
  if (args.documentHasFocus) {
    return false;
  }
  return true;
}

/** How often to bounce again while the window is still ignored. */
const BOUNCE_REPEAT_MS = 5_000;

let bounceTimer: number | null = null;
let unlistenFocus: (() => void) | null = null;

/**
 * One bounce.
 *
 * Cancelling first is what makes this repeat: macOS treats a fresh attention
 * request as a no-op while an earlier one is still outstanding, so asking
 * again on a timer produced exactly one bounce and then silence.
 */
function pulse() {
  void pulseDockAttention()
    .then((requestId) => {
      if (requestId > 0) {
        debugLog("status.notification", "dock bounce pulse", { requestId });
        return;
      }

      // `requestUserAttention:` hands back a request id, and zero means macOS
      // declined: it will not bounce an application that is already active.
      // Nothing above here can see that — the decision to bounce is made from
      // the *window's* focus, and a window can be unfocused while its app is
      // still frontmost, so the pulse loop was happily firing every five
      // seconds into a no-op.
      //
      // Stop rather than keep asking. The answer will not change until the
      // user leaves, and leaving is itself what the next attention event
      // reacts to.
      debugLog("status.notification", "dock bounce refused; app is already active", {
        requestId,
      });
      stopDockAttention();
    })
    .catch((error) => {
      debugLog("status.notification", "dock bounce failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

/**
 * Whether the app itself is frontmost.
 *
 * Asked directly rather than through the tracker in `appFocus`: this runs on a
 * timer while the dock is bouncing, so it can afford to await, and a missed
 * focus event would leave the dock bouncing at someone already looking at it.
 * See `appFocus` for why the document's answer is not good enough.
 */
async function isWindowFocused(): Promise<boolean> {
  try {
    return await getCurrentWindow().isFocused();
  } catch {
    return isAppFocused();
  }
}

export function stopDockAttention() {
  if (bounceTimer !== null) {
    window.clearInterval(bounceTimer);
    bounceTimer = null;
  }
  unlistenFocus?.();
  unlistenFocus = null;
  void cancelDockAttention().catch(() => {});
}

export function bounceDockForAttention(tabRootTerminalId: string, title: string) {
  debugLog("status.notification", "bouncing dock for attention", {
    tabRootTerminalId,
    title,
  });

  pulse();
  if (bounceTimer !== null) {
    // Already bouncing for another tab; one bounce covers both.
    return;
  }

  bounceTimer = window.setInterval(() => {
    void isWindowFocused().then((focused) => {
      if (focused) {
        stopDockAttention();
        return;
      }
      pulse();
    });
  }, BOUNCE_REPEAT_MS);

  void getCurrentWindow()
    .onFocusChanged(({ payload: focused }) => {
      if (focused) {
        stopDockAttention();
      }
    })
    .then((unlisten) => {
      // Racing a stop that already happened would leave a listener behind.
      if (bounceTimer === null) {
        unlisten();
        return;
      }
      unlistenFocus = unlisten;
    })
    .catch(() => {});
}
