/**
 * Closing and reopening local tabs.
 *
 * A local tab's shell lives in the PTY daemon, not in the tab, and it is only
 * ever killed by `close_terminal`. Closing a tab used to send that at once,
 * which is why ⇧⌘T could bring back a tmux window and never a local tab: the
 * one thing that could not be rebuilt had already been thrown away.
 *
 * So closing now takes the tab off screen and leaves the shell running, and
 * reopening puts the tab back under the same terminal ids. Mounting it asks
 * the backend for those terminals, which reattaches to the shells and replays
 * what they printed -- the same path that carries a tab across a reload.
 */

import type { TerminalSession } from "../types/terminal";
import { disposeTerminalInstance } from "../hooks/useTerminalBridge";
import { useLayoutStore } from "../stores/useLayoutStore";
import { useProjectStore } from "../stores/useProjectStore";
import { useTerminalStore } from "../stores/useTerminalStore";
import {
  type ClosedLocalTab,
  expiredClosedTabs,
  forgetClosedTab,
  isClosedLocalTab,
  peekMostRecentlyClosed,
  rememberClosedTab,
} from "./closedTabs";
import { debugLog } from "./debugLog";
import { createLeaf, findTerminalIds } from "./layoutUtils";
import { closeTerminal } from "./tauriCommands";
import { endEvictedClosedTmuxTabs, reopenClosedTmuxTab } from "./tmuxControl";

/** Really end a closed local tab: its shells are what was being kept. */
export function killClosedLocalTab(tab: ClosedLocalTab, reason: string) {
  debugLog("tmux.action", "killing a closed local tab", {
    tabId: tab.tabId,
    title: tab.title,
    terminalIds: tab.terminalIds,
    reason,
  });
  for (const terminalId of tab.terminalIds) {
    closeTerminal(terminalId).catch(() => {});
  }
}

/**
 * Remember a local tab that is about to be taken off screen.
 *
 * Read before anything is removed, because removing it is what destroys the
 * sessions, layout and sidebar row this has to keep. Returns the terminal ids
 * whose shells are now being kept, or null when there is no such tab -- in
 * which case the caller should close it the old way.
 *
 * Whatever this pushes past the cap is ended now, of either kind, rather than
 * left running with nothing remembering it.
 */
export function rememberClosedLocalTab(
  tabId: string,
  projectId: string
): string[] | null {
  const { projects, nodes } = useProjectStore.getState();
  const project = projects[projectId];
  if (!project) {
    return null;
  }
  const root = nodes[project.rootGroupId];
  const siblings = root?.children ?? [];
  const nodeId = siblings.find((childId) => {
    const child = nodes[childId];
    return child?.type === "terminal" && child.terminalId === tabId;
  });
  const node = nodeId ? nodes[nodeId] : undefined;
  if (!node) {
    return null;
  }

  const layout = useLayoutStore.getState().layouts[tabId] ?? null;
  const terminalIds = [...new Set([tabId, ...(layout ? findTerminalIds(layout) : [])])];
  const allSessions = useTerminalStore.getState().sessions;
  const sessions = terminalIds
    .map((terminalId) => allSessions[terminalId])
    .filter((session): session is TerminalSession => Boolean(session));
  // Only local shells can be reattached by id. Anything else in the layout
  // means this is not the tab this was written for.
  if (sessions.some((session) => (session.backendKind ?? "local") !== "local")) {
    return null;
  }

  const index = siblings.indexOf(node.id);
  const evicted = rememberClosedTab({
    kind: "local",
    tabId,
    terminalIds,
    layout,
    sessions,
    node,
    anchorNodeId: index > 0 ? siblings[index - 1] : null,
    project,
    projectRootNode: root ?? null,
    title: allSessions[tabId]?.title ?? node.name,
    closedAt: Date.now(),
  });
  for (const stale of evicted.filter(isClosedLocalTab)) {
    killClosedLocalTab(stale, "closed-tab-evicted");
  }
  endEvictedClosedTmuxTabs(evicted);
  return terminalIds;
}

/**
 * A closed session as it should come back.
 *
 * What the user set -- title, notes, pins, notifications -- is kept. The
 * status is not: it described a tab that has been off screen since, and the
 * replay arriving on reattach will say what it is now.
 */
function revivedSession(session: TerminalSession): TerminalSession {
  return {
    ...session,
    hasDetectedActivity: false,
    lastUserInputAt: 0,
    lastOutputAt: 0,
    lastLivenessAt: 0,
    isNeedsAttention: false,
    isPossiblyDone: false,
    isLongInactive: false,
    isRecentlyFocused: false,
  };
}

/**
 * Put a closed local tab back where it was and land in it.
 *
 * Returns false, and stops offering the tab, when its ids are already in use:
 * reopening on top of a live tab would hand one shell to two of them.
 */
export function reopenClosedLocalTab(closed: ClosedLocalTab): boolean {
  const terminalState = useTerminalStore.getState();
  if (closed.terminalIds.some((terminalId) => terminalState.sessions[terminalId])) {
    forgetClosedTab(closed);
    debugLog("tmux.action", "closed local tab is already open; forgetting it", {
      tabId: closed.tabId,
      title: closed.title,
    });
    return false;
  }

  const projectStore = useProjectStore.getState();
  let project = projectStore.projects[closed.project.id];
  if (!project) {
    // Closing its last tab removed the project. Bring that back too, empty,
    // or the tab has nowhere to go.
    project = closed.project;
    projectStore.addNode({
      ...(closed.projectRootNode ?? {
        id: project.rootGroupId,
        type: "group",
        name: project.name,
        parentId: null,
      }),
      children: [],
    });
    projectStore.addProject(project);
  }
  if (!project.expanded) {
    projectStore.toggleProjectExpanded(project.id);
  }

  useTerminalStore.setState((state) => {
    const sessions = { ...state.sessions };
    for (const session of closed.sessions) {
      sessions[session.id] = revivedSession(session);
    }
    return { sessions };
  });
  useLayoutStore.setState((state) => ({
    layouts: { ...state.layouts, [closed.tabId]: closed.layout ?? createLeaf(closed.tabId) },
  }));

  const parentId = project.rootGroupId;
  projectStore.addNode({ ...closed.node, parentId });
  const siblings = useProjectStore.getState().nodes[parentId]?.children ?? [];
  const anchorIndex = closed.anchorNodeId ? siblings.indexOf(closed.anchorNodeId) : -1;
  if (closed.anchorNodeId === null) {
    projectStore.insertChildAt(parentId, closed.node.id, 0);
  } else if (anchorIndex >= 0) {
    projectStore.insertChildAt(parentId, closed.node.id, anchorIndex + 1);
  } else {
    projectStore.addChildToNode(parentId, closed.node.id);
  }

  forgetClosedTab(closed);
  projectStore.setActiveProject(project.id);
  useTerminalStore.getState().setActiveTerminal(closed.tabId);
  debugLog("tmux.action", "reopened a closed local tab", {
    tabId: closed.tabId,
    title: closed.title,
    terminalIds: closed.terminalIds,
    projectId: project.id,
    closedForMs: Date.now() - closed.closedAt,
  });
  return true;
}

/**
 * Take a tab's terminals off screen without ending their shells.
 *
 * The frontends go -- the xterm instances and the channel bookkeeping -- so
 * that reopening builds fresh ones and asks the backend again, which is what
 * makes it reattach and replay.
 */
export function detachClosedLocalTerminals(terminalIds: readonly string[]) {
  for (const terminalId of terminalIds) {
    disposeTerminalInstance(terminalId);
    useTerminalStore.getState().removeSession(terminalId);
  }
}

/** End any closed local tab whose grace period has run out. */
export function reapExpiredClosedLocalTabs(): void {
  for (const tab of expiredClosedTabs(Date.now()).filter(isClosedLocalTab)) {
    killClosedLocalTab(tab, "grace-period-expired");
    forgetClosedTab(tab);
  }
}

/**
 * Bring back whatever was closed last, local or tmux, as a browser would.
 *
 * One list for both, so the shortcut walks back through tabs in the order they
 * were closed rather than favouring one kind.
 */
export async function reopenLastClosedTab(): Promise<boolean> {
  const closed = peekMostRecentlyClosed(Date.now());
  if (!closed) {
    debugLog("tmux.action", "nothing left to reopen", {});
    return false;
  }
  return isClosedLocalTab(closed) ? reopenClosedLocalTab(closed) : reopenClosedTmuxTab(closed);
}
