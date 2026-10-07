/**
 * Tabs that have been closed but not yet destroyed.
 *
 * Reopening a browser tab works because nothing was thrown away. A tmux window
 * is the same: once `kill-window` runs, the pane and everything in it are gone
 * and no amount of bookkeeping brings them back. So closing a tmux tab stops
 * projecting it and leaves the window running, and the kill is deferred.
 *
 * A local tab is the same again. Its PTY is killed by `close_terminal` and by
 * nothing else, so closing defers that too, and the shell is still there to
 * reattach to when the tab comes back.
 *
 * The cost is real and worth stating plainly: a closed tab's program keeps
 * running. An agent mid-task keeps working, and keeps spending, until the
 * window is actually reaped.
 *
 * Kept out of the workspace document. This is a desktop-local grace period,
 * not something replicas should see or something worth restoring from a
 * backup — a revived tab whose tmux server died long ago is worse than no
 * entry at all.
 */

import type { LayoutNode } from "../types/layout";
import type { Project, TreeNode } from "../types/project";
import type { TerminalSession } from "../types/terminal";
import { debugLog } from "./debugLog";
import { getScopedStorageKey } from "./storageNamespace";

/** How long a closed tab can be brought back before it is really killed. */
export const CLOSED_TAB_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Cap on how many are remembered.
 *
 * Each one is a live tmux window holding a process, so this is a resource
 * bound rather than a display one. Closing a great many tabs should not
 * quietly leave a great many programs running.
 */
export const MAX_CLOSED_TABS = 25;

/**
 * What a tab carries that only the user put there.
 *
 * A reopened tmux window is projected afresh, as a new terminal, and a new
 * terminal starts with nothing written in it. Without these the tab comes
 * back holding the right program and none of what was said about it.
 */
export type ClosedTabSettings = Partial<Pick<
  TerminalSession,
  | "notes"
  | "isPinnedGreen"
  | "isPinnedGray"
  | "notifyOnInaction"
  | "bounceOnAttention"
  | "pushOnInaction"
  | "inactivityThresholdMs"
>>;

const SETTINGS_KEYS = [
  "notes",
  "isPinnedGreen",
  "isPinnedGray",
  "notifyOnInaction",
  "bounceOnAttention",
  "pushOnInaction",
  "inactivityThresholdMs",
] as const satisfies readonly (keyof ClosedTabSettings)[];

export function pickClosedTabSettings(session: TerminalSession | undefined): ClosedTabSettings {
  const settings: ClosedTabSettings = {};
  if (!session) {
    return settings;
  }
  for (const key of SETTINGS_KEYS) {
    if (session[key] !== undefined) {
      (settings as Record<string, unknown>)[key] = session[key];
    }
  }
  return settings;
}

export interface ClosedTmuxTab {
  /** Absent on entries written before local tabs could be reopened. */
  kind?: "tmux";
  /**
   * Durable identity of the tmux server this window belongs to.
   *
   * Window ids are only unique within one server lifetime and are recycled, so
   * an id alone can resurrect the wrong window against a server that has since
   * restarted.
   */
  connectionKey: string | null;
  /**
   * The control session the tab was closed from.
   *
   * Closing removes the window from the projection, so afterwards no session
   * claims the window id and it cannot be found by searching for it. This is
   * the way back to the transport that can still reach it.
   */
  sessionId: string;
  windowId: string;
  /**
   * The panes hidden along with the window.
   *
   * Closing hides each pane by id, and the panes are dropped from the session
   * the moment the projection goes, so reopening has no other way to work out
   * what it has to un-hide. A window whose panes stay hidden comes back with
   * nothing in it.
   */
  paneIds: string[];
  /**
   * The tab that sat above this one.
   *
   * Reopening has to put the window back into the session's order, or its
   * sidebar row is never inserted and the tab comes back invisibly. Null means
   * it was first.
   */
  anchorWindowId: string | null;
  /** The window terminal's own settings, notes above all. */
  settings?: ClosedTabSettings;
  /** Each pane's, by pane id, since panes come back as new terminals too. */
  paneSettings?: Record<string, ClosedTabSettings>;
  title: string;
  closedAt: number;
}

/**
 * A local tab, closed with its shell still running.
 *
 * The PTY outlives its tab the same way it outlives a reload, and asking for
 * the same terminal id again reattaches to it and replays what it printed. So
 * this keeps the tab's furniture -- its sessions, layout and sidebar row --
 * and reopening is putting that back under the ids the shells still answer to.
 */
export interface ClosedLocalTab {
  kind: "local";
  /** The tab root, which is also its layout key. */
  tabId: string;
  /** Every terminal in the tab, splits included: each one is a live shell. */
  terminalIds: string[];
  layout: LayoutNode | null;
  sessions: TerminalSession[];
  node: TreeNode;
  /** The row above this one, or null when it was first. */
  anchorNodeId: string | null;
  /**
   * The project as it was, so closing its last tab does not leave the tab
   * with nowhere to come back to.
   */
  project: Project;
  projectRootNode: TreeNode | null;
  title: string;
  closedAt: number;
}

export type ClosedTab = ClosedTmuxTab | ClosedLocalTab;

export function isClosedLocalTab(tab: ClosedTab): tab is ClosedLocalTab {
  return tab.kind === "local";
}

export function isClosedTmuxTab(tab: ClosedTab): tab is ClosedTmuxTab {
  return tab.kind !== "local";
}

/** The id a closed tab goes by: its tmux window, or its local tab root. */
export function closedTabId(tab: ClosedTab): string {
  return isClosedLocalTab(tab) ? tab.tabId : tab.windowId;
}

const STORAGE_KEY = getScopedStorageKey("dispatcher.closedTabs");

/**
 * The list as this session last wrote it.
 *
 * localStorage is only how the list outlives a restart; within a session this
 * is the record. WebKit can stop keeping writes without throwing — the value
 * even reads back straight after `setItem`, then is gone a moment later — and
 * trusting storage then made a tab closed a second ago unreopenable.
 */
let written: ClosedTab[] | null = null;
let warnedStorageLost = false;

/** Forgets the in-memory list, as a restart would. For tests. */
export function resetClosedTabsMemory() {
  written = null;
  warnedStorageLost = false;
}

function readStorage(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function read(): ClosedTab[] {
  if (typeof window === "undefined") {
    return [];
  }
  const raw = readStorage();
  if (written) {
    if (raw !== JSON.stringify(written) && !warnedStorageLost) {
      warnedStorageLost = true;
      debugLog("tmux.action", "localStorage lost the closed tabs; using the list in memory", {
        count: written.length,
        stored: raw === null ? "missing" : "different",
      });
    }
    return written;
  }
  try {
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as ClosedTab[]) : [];
  } catch {
    return [];
  }
}

function write(entries: readonly ClosedTab[]) {
  if (typeof window === "undefined") {
    return;
  }
  written = [...entries];
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Still held in memory for this session.
  }
}

/**
 * A window's identity across tmux servers.
 *
 * The window id alone is not it. tmux recycles ids between server lifetimes,
 * so keying on one lets an entry for one server evict — or resurrect — the
 * unrelated window that inherited its id somewhere else.
 */
function identityOf(tab: ClosedTab): string {
  if (isClosedLocalTab(tab)) {
    return `local\u0000${tab.tabId}`;
  }
  return `${tab.connectionKey ?? "<none>"}\u0000${tab.windowId}`;
}

/** Newest first, which is the order reopening walks. */
export function listClosedTabs(): ClosedTab[] {
  return [...read()].sort((a, b) => b.closedAt - a.closedAt);
}

/**
 * Add an entry, dropping the oldest past the cap.
 *
 * The dropped ones are returned so the caller can kill them now rather than
 * leaking a window that nothing remembers.
 */
export function rememberClosedTab(tab: ClosedTab): ClosedTab[] {
  const key = identityOf(tab);
  const kept = [tab, ...read().filter((entry) => identityOf(entry) !== key)]
    .sort((a, b) => b.closedAt - a.closedAt);
  const evicted = kept.slice(MAX_CLOSED_TABS);
  write(kept.slice(0, MAX_CLOSED_TABS));
  debugLog("tmux.action", "remembered a closed tab", {
    kind: tab.kind ?? "tmux",
    id: closedTabId(tab),
    title: tab.title,
    remembered: Math.min(kept.length, MAX_CLOSED_TABS),
    evicted: evicted.length,
  });
  return evicted;
}

export function forgetClosedTab(tab: ClosedTab) {
  const key = identityOf(tab);
  write(read().filter((entry) => identityOf(entry) !== key));
}

/**
 * The most recent one still worth reopening, or null.
 *
 * Expired entries are stepped over rather than returned: reopening should give
 * you a tab, not a stale row that fails.
 */
export function takeMostRecentlyClosed(now: number): ClosedTab | null {
  const next = peekMostRecentlyClosed(now);
  if (next) {
    forgetClosedTab(next);
  }
  return next;
}

/**
 * The same entry, left where it is.
 *
 * Reopening has to be able to fail. The server may be unreachable — a dropped
 * ssh leaves the control stream answering nothing — and forgetting the tab
 * before knowing whether it came back loses it for good: the shortcut reports
 * success, no tab appears, and pressing it again reaches for an older one. A
 * tab is only forgotten once it is on screen, or once the server says the
 * window is gone.
 */
export function peekMostRecentlyClosed(now: number): ClosedTab | null {
  return listClosedTabs().find((entry) => !isClosedTabExpired(entry, now)) ?? null;
}

/** The newest tmux entry, stepping over local ones. */
export function peekMostRecentlyClosedTmux(now: number): ClosedTmuxTab | null {
  return listClosedTabs()
    .filter(isClosedTmuxTab)
    .find((entry) => !isClosedTabExpired(entry, now)) ?? null;
}

export function isClosedTabExpired(tab: ClosedTab, now: number): boolean {
  return now - tab.closedAt >= CLOSED_TAB_TTL_MS;
}

/**
 * Entries past their deadline.
 *
 * Reading, not draining. The caller can only kill a window while something is
 * attached to its server, and at startup nothing is yet — dropping the entry
 * there would leave the window alive *and* un-hidden, so the tab the user
 * closed yesterday would walk back in. Each one is forgotten as it is killed.
 */
export function expiredClosedTabs(now: number): ClosedTab[] {
  const expired = read().filter((entry) => isClosedTabExpired(entry, now));
  if (expired.length > 0) {
    debugLog("tmux.action", "closed tabs are past their grace period", {
      count: expired.length,
      ids: expired.map(closedTabId),
    });
  }
  return expired;
}

/** Window ids to keep hidden for a given tmux server, across app restarts. */
export function hiddenWindowIdsForConnection(connectionKey: string | null): string[] {
  return read()
    .filter(isClosedTmuxTab)
    .filter((entry) => entry.connectionKey === connectionKey)
    .map((entry) => entry.windowId);
}
