/**
 * Opening the tab a notification was about.
 *
 * Two arrivals to handle, and they are genuinely different. If the web app is
 * already running the service worker can post a message straight to it. If it
 * is not, the worker has to launch it, and a message posted to a page that is
 * still booting is simply lost — so the terminal travels in the URL instead,
 * and is read once the workspace has loaded.
 */

import { useProjectStore } from "../stores/useProjectStore";
import { useTerminalStore } from "../stores/useTerminalStore";
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

  // Project first: activating a terminal in a project that is not showing
  // leaves the sidebar pointing somewhere else.
  projectStore.setActiveProject(projectId);
  terminalStore.setActiveTerminal(terminalId);
  debugLog("push", "opened the tab a notification was about", { terminalId, projectId });
  return true;
}
