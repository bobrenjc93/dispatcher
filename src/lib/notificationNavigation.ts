/**
 * Opening the tab a notification was about.
 *
 * Two arrivals to handle, and they are genuinely different. If the web app is
 * already running the service worker can post a message straight to it. If it
 * is not, the worker has to launch it, and a message posted to a page that is
 * still booting is simply lost — so the terminal travels in the URL instead,
 * and is read once the workspace has loaded.
 */

import { useLayoutStore } from "../stores/useLayoutStore";
import { useProjectStore } from "../stores/useProjectStore";
import { useTerminalStore } from "../stores/useTerminalStore";
import { findTerminalIds } from "./layoutUtils";
import { handleTmuxTerminalFocus } from "./tmuxControl";
import { findProjectIdForTerminal } from "./treeUtils";
import { debugLog } from "./debugLog";

/** Query parameter the service worker uses when it has to open a window. */
export const FOCUS_TERMINAL_PARAM = "terminal";

export const FOCUS_TERMINAL_MESSAGE = "dispatcher:focus-terminal";

/**
 * Pull the requested terminal out of a URL and say what the URL should become.
 *
 * The parameter is stripped rather than left in place: it describes one
 * arrival, and leaving it would make a later reload jump back to a tab the
 * user has since navigated away from.
 */
export function readFocusTerminalFromUrl(href: string): {
  terminalId: string | null;
  cleanedHref: string;
} {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return { terminalId: null, cleanedHref: href };
  }

  const terminalId = url.searchParams.get(FOCUS_TERMINAL_PARAM);
  if (!terminalId) {
    return { terminalId: null, cleanedHref: href };
  }
  url.searchParams.delete(FOCUS_TERMINAL_PARAM);
  return { terminalId, cleanedHref: url.toString() };
}

/**
 * The terminal inside a tab that should actually take focus.
 *
 * A notification names the tab root, and for a tmux tab that is the *window*
 * terminal — a placeholder that is never rendered. Focusing it activates a tab
 * with nothing in it, which is why tapping a notification appeared to do
 * nothing at all.
 *
 * Resolved from the layout rather than from the tmux control session, which is
 * how the rest of the app does it: control sessions live only on the desktop,
 * and the device tapping the notification is a phone.
 */
export function resolveNotificationFocusTarget(tabRootTerminalId: string): string {
  const layout = useLayoutStore.getState().layouts[tabRootTerminalId];
  if (!layout) {
    return tabRootTerminalId;
  }
  const sessions = useTerminalStore.getState().sessions;
  const rendered = findTerminalIds(layout).filter((id) => sessions[id]);
  // Prefer whichever pane is already active, so returning to a split tab lands
  // where it was left.
  const active = useTerminalStore.getState().activeTerminalId;
  if (active && rendered.includes(active)) {
    return active;
  }
  return rendered[0] ?? tabRootTerminalId;
}

/**
 * Switch to a terminal's tab.
 *
 * Returns whether it worked: a notification can outlive the tab it was about —
 * closed, or the workspace not yet loaded on a cold start — and silently doing
 * nothing looks identical to the tap not registering.
 */
export function focusTerminalFromNotification(terminalId: string): boolean {
  const projectStore = useProjectStore.getState();
  const terminalStore = useTerminalStore.getState();

  const projectId = findProjectIdForTerminal(
    projectStore.projects,
    projectStore.projectOrder,
    projectStore.nodes,
    terminalStore.sessions,
    terminalId
  );

  if (!projectId) {
    debugLog("push", "notification target is gone", { terminalId });
    return false;
  }

  const focusTarget = resolveNotificationFocusTarget(terminalId);

  // The same three steps as clicking the tab in the sidebar. Doing only the
  // first two activates the tab without focusing anything in it, and on a tmux
  // tab that meant activating a window placeholder rather than its pane.
  projectStore.setActiveProject(projectId);
  terminalStore.setActiveTerminal(focusTarget);
  handleTmuxTerminalFocus(focusTarget);

  debugLog("push", "opened the tab a notification was about", {
    terminalId,
    focusTarget,
    projectId,
  });
  return true;
}
