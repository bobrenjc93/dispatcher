import { normalizeRestoredTmuxState } from "./restoredTmuxState";
import { debugLog } from "./debugLog";
import { isPrimaryClient } from "./replication";
import { useLayoutStore } from "../stores/useLayoutStore";
import { useProjectStore } from "../stores/useProjectStore";
import { useTerminalStore } from "../stores/useTerminalStore";
import {
  clearActiveTerminalIntent,
  getActiveTerminalIntent,
  resolveAdoptedActiveTerminal,
} from "./activeTerminalIntent";
import {
  APP_STATE_LAYOUTS_KEY,
  APP_STATE_PROJECTS_KEY,
  APP_STATE_STORAGE_KEYS,
  APP_STATE_TERMINALS_KEY,
  getScopedAppStateStorageKey,
  getStorageNamespaceLabel,
} from "./storageNamespace";
import type { LayoutNode } from "../types/layout";
import type { Project, TreeNode } from "../types/project";
import type { TerminalSession } from "../types/terminal";

/**
 * Whether two terminals are the window and pane halves of one tmux tab.
 *
 * Keyed on the connection as well as the window id, because window ids are
 * recycled between servers and two unrelated tabs can both be `@9`.
 */
export function sharesTmuxTab(
  a: TerminalSession | undefined,
  b: TerminalSession | undefined
): boolean {
  if (!a || !b || !a.tmuxWindowId || !b.tmuxWindowId) {
    return false;
  }
  return (
    a.tmuxWindowId === b.tmuxWindowId
    && (a.tmuxConnectionKey ?? null) === (b.tmuxConnectionKey ?? null)
  );
}

export interface PersistedProjectState {
  projects?: Record<string, Project>;
  nodes?: Record<string, TreeNode>;
  activeProjectId?: string | null;
  projectOrder?: string[];
}

export interface PersistedTerminalState {
  sessions?: Record<string, TerminalSession>;
  activeTerminalId?: string | null;
}

export interface PersistedLayoutState {
  layouts?: Record<string, LayoutNode>;
}

interface PersistedStore<T> {
  state?: T;
  version?: number;
}

export interface AppStateSnapshot {
  source?: string;
  exportedAt?: string;
  [APP_STATE_PROJECTS_KEY]?: PersistedStore<PersistedProjectState>;
  [APP_STATE_TERMINALS_KEY]?: PersistedStore<PersistedTerminalState>;
  [APP_STATE_LAYOUTS_KEY]?: PersistedStore<PersistedLayoutState>;
}

export interface AppStateCounts {
  projects: number;
  nodes: number;
  layouts: number;
  sessions: number;
  activeProjectId: string | null;
  activeTerminalId: string | null;
}

export interface RestoreAppStateResult {
  restored: boolean;
  reason?: string;
  counts?: AppStateCounts;
}

export function getLiveAppStateCounts(): AppStateCounts {
  const projectState = useProjectStore.getState();
  const terminalState = useTerminalStore.getState();
  const layoutState = useLayoutStore.getState();

  return {
    projects: Object.keys(projectState.projects).length,
    nodes: Object.keys(projectState.nodes).length,
    layouts: Object.keys(layoutState.layouts).length,
    sessions: Object.keys(terminalState.sessions).length,
    activeProjectId: projectState.activeProjectId,
    activeTerminalId: terminalState.activeTerminalId,
  };
}

export function hasLiveAppState(): boolean {
  const counts = getLiveAppStateCounts();
  return counts.projects > 0 || counts.sessions > 0 || counts.layouts > 0;
}

export function buildAppStateSnapshot(): AppStateSnapshot {
  const projectState = useProjectStore.getState();
  const terminalState = useTerminalStore.getState();
  const layoutState = useLayoutStore.getState();

  return {
    source: "dispatcher-app-state-backup",
    exportedAt: new Date().toISOString(),
    [APP_STATE_PROJECTS_KEY]: {
      state: {
        projects: projectState.projects,
        nodes: projectState.nodes,
        activeProjectId: projectState.activeProjectId,
        projectOrder: projectState.projectOrder,
      },
      version: 0,
    },
    [APP_STATE_TERMINALS_KEY]: {
      state: {
        sessions: terminalState.sessions,
        activeTerminalId: terminalState.activeTerminalId,
      },
      version: 0,
    },
    [APP_STATE_LAYOUTS_KEY]: {
      state: {
        layouts: layoutState.layouts,
      },
      version: 0,
    },
  };
}

function getSnapshotCounts(snapshot: AppStateSnapshot): AppStateCounts {
  const projectState = snapshot[APP_STATE_PROJECTS_KEY]?.state;
  const terminalState = snapshot[APP_STATE_TERMINALS_KEY]?.state;
  const layoutState = snapshot[APP_STATE_LAYOUTS_KEY]?.state;

  return {
    projects: Object.keys(projectState?.projects ?? {}).length,
    nodes: Object.keys(projectState?.nodes ?? {}).length,
    layouts: Object.keys(layoutState?.layouts ?? {}).length,
    sessions: Object.keys(terminalState?.sessions ?? {}).length,
    activeProjectId: projectState?.activeProjectId ?? null,
    activeTerminalId: terminalState?.activeTerminalId ?? null,
  };
}

export function snapshotHasAppState(snapshot: AppStateSnapshot): boolean {
  const counts = getSnapshotCounts(snapshot);
  return counts.projects > 0 || counts.sessions > 0 || counts.layouts > 0;
}

/**
 * Identity of a snapshot's actual contents, ignoring the bookkeeping fields
 * that change on every build. Two clients that agree on the state produce the
 * same signature, which is what stops a shared-state update from bouncing back
 * and forth between them forever.
 */
export function getAppStateSignature(snapshot: AppStateSnapshot): string {
  return JSON.stringify([
    snapshot[APP_STATE_PROJECTS_KEY]?.state ?? null,
    snapshot[APP_STATE_TERMINALS_KEY]?.state ?? null,
    snapshot[APP_STATE_LAYOUTS_KEY]?.state ?? null,
  ]);
}

/**
 * Adopt state published by another live client.
 *
 * Unlike {@link restoreAppStateSnapshot} this does not run the tmux
 * normalization pass: that pass exists to downgrade tmux tabs to placeholders
 * after a restart, and applying it here would tear down sessions that are
 * still very much alive in the client that sent them.
 */
export function applySharedAppState(
  snapshot: AppStateSnapshot,
  source: string
): RestoreAppStateResult {
  const projectState = snapshot[APP_STATE_PROJECTS_KEY]?.state;
  const terminalState = snapshot[APP_STATE_TERMINALS_KEY]?.state;
  const layoutState = snapshot[APP_STATE_LAYOUTS_KEY]?.state;

  if (!projectState?.projects || !projectState.nodes || !terminalState?.sessions || !layoutState?.layouts) {
    return { restored: false, reason: "invalid", counts: getSnapshotCounts(snapshot) };
  }

  useProjectStore.setState({
    projects: projectState.projects,
    nodes: projectState.nodes,
    activeProjectId: projectState.activeProjectId ?? null,
    projectOrder: projectState.projectOrder ?? Object.keys(projectState.projects),
  });
  useLayoutStore.setState({
    layouts: layoutState.layouts,
  });
  // Which tab is active belongs to the desktop window. A replica changes tabs
  // by relaying the intent, and the master's next snapshot carries the result
  // back — so adopting a replica's own value here would let a snapshot that
  // was in flight when the click happened revert it, on either side.
  const localActiveTerminalId = useTerminalStore.getState().activeTerminalId;
  const keepLocalActiveTerminal = isPrimaryClient() && localActiveTerminalId !== null;
  // A replica adopts the desktop's tab, except while waiting to hear back
  // about one it just picked itself. Snapshots published before the desktop
  // knew still name the old tab, and how often those arrive depends only on
  // how busy that tab is — which is why tapping a push notification switched
  // tabs or did not depending on what the tab you were already on was doing.
  const intent = isPrimaryClient() ? null : getActiveTerminalIntent();
  const adopted = resolveAdoptedActiveTerminal({
    incoming: terminalState.activeTerminalId ?? null,
    intent,
    now: Date.now(),
    incomingSharesTab: sharesTmuxTab(
      terminalState.sessions[intent?.terminalId ?? ""],
      terminalState.sessions[terminalState.activeTerminalId ?? ""]
    ),
  });
  if (adopted.intentSettled) {
    clearActiveTerminalIntent();
  }
  useTerminalStore.setState({
    sessions: terminalState.sessions,
    activeTerminalId: keepLocalActiveTerminal
      ? localActiveTerminalId
      : adopted.activeTerminalId,
  });

  writeAppStateSnapshotToLocalStorage(snapshot);
  const counts = getLiveAppStateCounts();

  debugLog("app.persistence", "applied shared state snapshot", {
    source,
    counts,
  });

  return { restored: true, counts };
}

export function parseAppStateSnapshot(raw: string): AppStateSnapshot | null {
  try {
    const parsed = JSON.parse(raw) as AppStateSnapshot;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function writeAppStateSnapshotToLocalStorage(snapshot: AppStateSnapshot): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    for (const key of APP_STATE_STORAGE_KEYS) {
      const value = snapshot[key];
      if (value) {
        window.localStorage.setItem(getScopedAppStateStorageKey(key), JSON.stringify(value));
      }
    }
    return true;
  } catch (error) {
    debugLog("app.persistence", "localStorage mirror failed", {
      storageNamespace: getStorageNamespaceLabel(),
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export function restoreAppStateSnapshot(
  snapshot: AppStateSnapshot,
  source: string
): RestoreAppStateResult {
  const projectState = snapshot[APP_STATE_PROJECTS_KEY]?.state;
  const terminalState = snapshot[APP_STATE_TERMINALS_KEY]?.state;
  const layoutState = snapshot[APP_STATE_LAYOUTS_KEY]?.state;

  if (!projectState?.projects || !projectState.nodes || !terminalState?.sessions || !layoutState?.layouts) {
    const counts = getSnapshotCounts(snapshot);
    debugLog("app.persistence", "invalid state snapshot", {
      source,
      storageNamespace: getStorageNamespaceLabel(),
      counts,
      hasProjects: Boolean(projectState?.projects),
      hasNodes: Boolean(projectState?.nodes),
      hasSessions: Boolean(terminalState?.sessions),
      hasLayouts: Boolean(layoutState?.layouts),
    });
    return { restored: false, reason: "invalid", counts };
  }

  const normalized = normalizeRestoredTmuxState({
    projects: projectState.projects,
    nodes: projectState.nodes,
    activeProjectId: projectState.activeProjectId ?? null,
    projectOrder: projectState.projectOrder ?? Object.keys(projectState.projects),
    sessions: terminalState.sessions,
    activeTerminalId: terminalState.activeTerminalId ?? null,
    layouts: layoutState.layouts,
  });

  useProjectStore.setState({
    projects: normalized.projects,
    nodes: normalized.nodes,
    activeProjectId: normalized.activeProjectId,
    projectOrder: normalized.projectOrder,
  });
  useLayoutStore.setState({
    layouts: normalized.layouts,
  });
  useTerminalStore.setState({
    sessions: normalized.sessions,
    activeTerminalId: normalized.activeTerminalId,
  });

  const normalizedSnapshot = buildAppStateSnapshot();
  const mirroredToLocalStorage = writeAppStateSnapshotToLocalStorage(normalizedSnapshot);
  const counts = getLiveAppStateCounts();

  debugLog("app.persistence", "restored state snapshot", {
    source,
    storageNamespace: getStorageNamespaceLabel(),
    counts,
    mirroredToLocalStorage,
  });

  return { restored: true, counts };
}
