/**
 * Tabs that have been closed but not yet destroyed.
 *
 * Reopening a browser tab works because nothing was thrown away. A tmux window
 * is the same: once `kill-window` runs, the pane and everything in it are gone
 * and no amount of bookkeeping brings them back. So closing a tmux tab stops
 * projecting it and leaves the window running, and the kill is deferred.
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

export interface ClosedTab {
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
  title: string;
  closedAt: number;
}

const STORAGE_KEY = getScopedStorageKey("dispatcher.closedTabs");

function read(): ClosedTab[] {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
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
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Losing the list costs the ability to reopen, not correctness — the
    // windows themselves are still reaped by their own deadline.
  }
}

/**
 * A window's identity across tmux servers.
 *
 * The window id alone is not it. tmux recycles ids between server lifetimes,
 * so keying on one lets an entry for one server evict — or resurrect — the
 * unrelated window that inherited its id somewhere else.
 */
function identityOf(tab: Pick<ClosedTab, "connectionKey" | "windowId">): string {
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
    windowId: tab.windowId,
    title: tab.title,
    remembered: Math.min(kept.length, MAX_CLOSED_TABS),
    evicted: evicted.length,
  });
  return evicted;
}

export function forgetClosedTab(tab: Pick<ClosedTab, "connectionKey" | "windowId">) {
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
  const live = listClosedTabs().filter((entry) => !isClosedTabExpired(entry, now));
  const next = live[0] ?? null;
  if (next) {
    forgetClosedTab(next);
  }
  return next;
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
      windowIds: expired.map((entry) => entry.windowId),
    });
  }
  return expired;
}

/** Window ids to keep hidden for a given tmux server, across app restarts. */
export function hiddenWindowIdsForConnection(connectionKey: string | null): string[] {
  return read()
    .filter((entry) => entry.connectionKey === connectionKey)
    .map((entry) => entry.windowId);
}
