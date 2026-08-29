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
  isActiveTab: boolean;
  documentHasFocus: boolean;
}): boolean {
  if (!args.enabled || !args.nextNeedsAttention || args.wasNeedsAttention) {
    return false;
  }
  // Bouncing at someone already reading the tab is just noise.
  if (args.isActiveTab && args.documentHasFocus) {
    return false;
  }
  return true;
}

/** How often to bounce again while the window is still ignored. */
const BOUNCE_REPEAT_MS = 3_000;

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
      debugLog("status.notification", "dock bounce pulse", { requestId });
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
 * `document.hasFocus()` answers for the webview, which can report focus while
 * the app sits behind another one — believing it stopped the bouncing after a
 * single pulse.
 */
async function isWindowFocused(): Promise<boolean> {
  try {
    return await getCurrentWindow().isFocused();
  } catch {
    return typeof document !== "undefined" ? document.hasFocus() : false;
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
