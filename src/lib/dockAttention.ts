/**
 * Dock bouncing for tabs the user asked to be pulled back to.
 *
 * Distinct from "Notify on Inaction", which fires a sound once a tab has been
 * quiet for a while. This fires on the moment a tab *starts* needing
 * attention, which is the state the status dot already tracks, and it keeps
 * bouncing until the user activates Dispatcher.
 */

import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
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

/**
 * How often to re-ask for attention while the app is ignored.
 *
 * macOS is meant to keep bouncing for a critical request until the app is
 * activated, but the bounce is easy to lose — anything that briefly activates
 * the app, or another attention request, ends it. Re-asking keeps it going
 * until the window is genuinely looked at.
 */
const BOUNCE_REPEAT_MS = 3_000;

let bounceTimer: number | null = null;

function requestAttention() {
  void getCurrentWindow()
    .requestUserAttention(UserAttentionType.Critical)
    .catch((error) => {
      debugLog("status.notification", "dock bounce failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

/** Called once the window is looked at, and before starting a fresh bounce. */
export function stopDockAttention() {
  if (bounceTimer !== null) {
    window.clearInterval(bounceTimer);
    bounceTimer = null;
  }
  window.removeEventListener("focus", stopDockAttention);
  // Passing null cancels an outstanding request rather than making a new one.
  void getCurrentWindow().requestUserAttention(null).catch(() => {});
}

export function bounceDockForAttention(tabRootTerminalId: string, title: string) {
  debugLog("status.notification", "bouncing dock for attention", {
    tabRootTerminalId,
    title,
  });

  requestAttention();
  if (bounceTimer !== null) {
    // Already bouncing for something else; one bounce covers both.
    return;
  }

  bounceTimer = window.setInterval(() => {
    if (typeof document !== "undefined" && document.hasFocus()) {
      stopDockAttention();
      return;
    }
    requestAttention();
  }, BOUNCE_REPEAT_MS);

  // Clicking the app is the signal to stop; the interval is only a backstop
  // for focus changes that do not fire this.
  window.addEventListener("focus", stopDockAttention);
}
