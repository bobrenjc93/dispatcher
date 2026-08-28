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

export function bounceDockForAttention(tabRootTerminalId: string, title: string) {
  debugLog("status.notification", "bouncing dock for attention", {
    tabRootTerminalId,
    title,
  });
  // Critical keeps bouncing until Dispatcher is activated. "Notify on
  // Inaction" uses Informational, which bounces once — the difference is the
  // point of this option.
  void getCurrentWindow()
    .requestUserAttention(UserAttentionType.Critical)
    .catch((error) => {
      debugLog("status.notification", "dock bounce failed", {
        tabRootTerminalId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}
