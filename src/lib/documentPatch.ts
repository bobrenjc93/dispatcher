/**
 * Entity-level edits to the workspace document, sent from a replica to the
 * desktop window.
 *
 * The document (projects, tabs, splits, notes) is owned by the desktop, which
 * republishes it whenever it changes — including on its own for things like
 * status dots ticking over. A replica therefore cannot publish whole snapshots
 * back: its snapshot is a copy of a moment that has already moved on, and
 * sending it would undo whatever changed in between. That is what made an
 * expanded project in the browser snap shut again.
 *
 * Instead a replica sends only the fields it actually changed, and the desktop
 * merges them. Concurrent edits to different things no longer collide, and the
 * desktop stays the single writer of the document.
 */

import type { AppStateSnapshot } from "./appStateSnapshot";
import {
  APP_STATE_LAYOUTS_KEY,
  APP_STATE_PROJECTS_KEY,
  APP_STATE_TERMINALS_KEY,
} from "./storageNamespace";
import { useLayoutStore } from "../stores/useLayoutStore";
import { useProjectStore } from "../stores/useProjectStore";
import { useTerminalStore } from "../stores/useTerminalStore";
import type { LayoutNode } from "../types/layout";

type Fields = Record<string, unknown>;
type Entity = Record<string, unknown>;

export interface DocumentPatch {
  /** Only the fields that changed, per entity. */
  projects?: Record<string, Fields>;
  nodes?: Record<string, Fields>;
  sessions?: Record<string, Fields>;
  /** Layouts are trees, so a changed layout is sent whole. */
  layouts?: Record<string, LayoutNode>;
  removed?: {
    projects?: string[];
    nodes?: string[];
    sessions?: string[];
    layouts?: string[];
  };
  activeProjectId?: string | null;
  projectOrder?: string[];
  activeTerminalId?: string | null;
}

function shallowFieldDiff(base: Entity | undefined, next: Entity): Fields | null {
  if (!base) {
    return { ...next };
  }

  const changed: Fields = {};
  for (const [key, value] of Object.entries(next)) {
    if (!Object.is(base[key], value) && JSON.stringify(base[key]) !== JSON.stringify(value)) {
      changed[key] = value;
    }
  }
  // A field the user cleared still has to travel.
  for (const key of Object.keys(base)) {
    if (!(key in next)) {
      changed[key] = undefined;
    }
  }

  return Object.keys(changed).length > 0 ? changed : null;
}

function diffCollection(
  base: Record<string, Entity> | undefined,
  next: Record<string, Entity> | undefined
): { changed: Record<string, Fields>; removed: string[] } {
  const baseMap = base ?? {};
  const nextMap = next ?? {};
  const changed: Record<string, Fields> = {};

  for (const [id, entity] of Object.entries(nextMap)) {
    const fields = shallowFieldDiff(baseMap[id], entity);
    if (fields) {
      changed[id] = fields;
    }
  }

  const removed = Object.keys(baseMap).filter((id) => !(id in nextMap));
  return { changed, removed };
}

function isEmptyPatch(patch: DocumentPatch): boolean {
  return Object.keys(patch).length === 0;
}

/** Everything in `next` that differs from `base`, or null if nothing does. */
export function buildDocumentPatch(
  base: AppStateSnapshot,
  next: AppStateSnapshot
): DocumentPatch | null {
  const baseProjects = base[APP_STATE_PROJECTS_KEY]?.state;
  const nextProjects = next[APP_STATE_PROJECTS_KEY]?.state;
  const baseTerminals = base[APP_STATE_TERMINALS_KEY]?.state;
  const nextTerminals = next[APP_STATE_TERMINALS_KEY]?.state;
  const baseLayouts = base[APP_STATE_LAYOUTS_KEY]?.state?.layouts ?? {};
  const nextLayouts = next[APP_STATE_LAYOUTS_KEY]?.state?.layouts ?? {};

  const patch: DocumentPatch = {};
  const removed: NonNullable<DocumentPatch["removed"]> = {};

  const projects = diffCollection(
    baseProjects?.projects as Record<string, Entity> | undefined,
    nextProjects?.projects as Record<string, Entity> | undefined
  );
  if (Object.keys(projects.changed).length > 0) patch.projects = projects.changed;
  if (projects.removed.length > 0) removed.projects = projects.removed;

  const nodes = diffCollection(
    baseProjects?.nodes as Record<string, Entity> | undefined,
    nextProjects?.nodes as Record<string, Entity> | undefined
  );
  if (Object.keys(nodes.changed).length > 0) patch.nodes = nodes.changed;
  if (nodes.removed.length > 0) removed.nodes = nodes.removed;

  const sessions = diffCollection(
    baseTerminals?.sessions as Record<string, Entity> | undefined,
    nextTerminals?.sessions as Record<string, Entity> | undefined
  );
  if (Object.keys(sessions.changed).length > 0) patch.sessions = sessions.changed;
  if (sessions.removed.length > 0) removed.sessions = sessions.removed;

  const changedLayouts: Record<string, LayoutNode> = {};
  for (const [id, layout] of Object.entries(nextLayouts)) {
    if (JSON.stringify(baseLayouts[id]) !== JSON.stringify(layout)) {
      changedLayouts[id] = layout;
    }
  }
  if (Object.keys(changedLayouts).length > 0) patch.layouts = changedLayouts;
  const removedLayouts = Object.keys(baseLayouts).filter((id) => !(id in nextLayouts));
  if (removedLayouts.length > 0) removed.layouts = removedLayouts;

  if (Object.keys(removed).length > 0) patch.removed = removed;

  if ((baseProjects?.activeProjectId ?? null) !== (nextProjects?.activeProjectId ?? null)) {
    patch.activeProjectId = nextProjects?.activeProjectId ?? null;
  }
  if (
    JSON.stringify(baseProjects?.projectOrder ?? [])
    !== JSON.stringify(nextProjects?.projectOrder ?? [])
  ) {
    patch.projectOrder = nextProjects?.projectOrder ?? [];
  }
  if ((baseTerminals?.activeTerminalId ?? null) !== (nextTerminals?.activeTerminalId ?? null)) {
    patch.activeTerminalId = nextTerminals?.activeTerminalId ?? null;
  }

  return isEmptyPatch(patch) ? null : patch;
}

function mergeCollection<T>(
  current: Record<string, T>,
  changed: Record<string, Fields> | undefined,
  removedIds: string[] | undefined
): Record<string, T> {
  if (!changed && !removedIds?.length) {
    return current;
  }

  const next: Record<string, T> = { ...current };
  for (const [id, fields] of Object.entries(changed ?? {})) {
    const merged = { ...(next[id] as Entity | undefined), ...fields } as Entity;
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) {
        delete merged[key];
      }
    }
    next[id] = merged as T;
  }
  for (const id of removedIds ?? []) {
    delete next[id];
  }
  return next;
}

/** Apply a replica's edits to this client's stores. Runs on the desktop. */
export function applyDocumentPatch(patch: DocumentPatch) {
  if (!patch || isEmptyPatch(patch)) {
    return;
  }

  const projectState = useProjectStore.getState();
  useProjectStore.setState({
    projects: mergeCollection(projectState.projects, patch.projects, patch.removed?.projects),
    nodes: mergeCollection(projectState.nodes, patch.nodes, patch.removed?.nodes),
    activeProjectId:
      patch.activeProjectId !== undefined ? patch.activeProjectId : projectState.activeProjectId,
    projectOrder: patch.projectOrder ?? projectState.projectOrder,
  });

  const terminalState = useTerminalStore.getState();
  useTerminalStore.setState({
    sessions: mergeCollection(terminalState.sessions, patch.sessions, patch.removed?.sessions),
    activeTerminalId:
      patch.activeTerminalId !== undefined
        ? patch.activeTerminalId
        : terminalState.activeTerminalId,
  });

  const layoutState = useLayoutStore.getState();
  if (patch.layouts || patch.removed?.layouts?.length) {
    const layouts = { ...layoutState.layouts, ...(patch.layouts ?? {}) };
    for (const id of patch.removed?.layouts ?? []) {
      delete layouts[id];
    }
    useLayoutStore.setState({ layouts });
  }
}
