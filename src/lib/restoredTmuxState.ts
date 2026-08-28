import type { LayoutNode } from "../types/layout";
import type { Project, TreeNode } from "../types/project";
import type { TerminalBackendKind, TerminalSession } from "../types/terminal";
import { createLeaf, findLayoutKeyForTerminal, findTerminalIds } from "./layoutUtils";
import { collectVisibleTerminalRefs, findProjectIdForTerminal } from "./treeUtils";

export interface RestoredTmuxStateSnapshot {
  /**
   * Terminals whose PTY is still running in the backend. tmux tabs backed by
   * one of these are left intact instead of being downgraded to placeholders:
   * the transport survived, so the session behind it is still reachable and
   * rebuilding it by hand would mean another ssh and another tmux attach.
   */
  liveTerminalIds?: ReadonlySet<string>;
  sessions: Record<string, TerminalSession>;
  activeTerminalId: string | null;
  projects: Record<string, Project>;
  nodes: Record<string, TreeNode>;
  activeProjectId: string | null;
  projectOrder: string[];
  layouts: Record<string, LayoutNode>;
}

export interface RestoredTmuxStateNormalizationResult extends RestoredTmuxStateSnapshot {
  changed: boolean;
}

function dedupeIds(ids: readonly string[] | undefined): string[] | undefined {
  if (!ids) {
    return ids;
  }

  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      deduped.push(id);
    }
  }
  return deduped;
}

function pruneLayoutTree(
  node: LayoutNode,
  sessions: Record<string, TerminalSession>
): LayoutNode | null {
  if (node.type === "terminal") {
    return sessions[node.terminalId] ? node : null;
  }

  const first = pruneLayoutTree(node.first, sessions);
  const second = pruneLayoutTree(node.second, sessions);

  if (!first && !second) {
    return null;
  }
  if (!first) {
    return second;
  }
  if (!second) {
    return first;
  }

  return {
    ...node,
    first,
    second,
  };
}

function removeTerminalNode(
  nodes: Record<string, TreeNode>,
  nodeId: string
): void {
  const node = nodes[nodeId];
  if (!node) {
    return;
  }

  if (node.parentId && nodes[node.parentId]) {
    nodes[node.parentId] = {
      ...nodes[node.parentId],
      children: (nodes[node.parentId].children ?? []).filter((childId) => childId !== nodeId),
    };
  }

  delete nodes[nodeId];
}

function clearRestoreMarker(session: TerminalSession): TerminalSession {
  const effectiveBackendKind = session.restoredFromBackendKind ?? session.backendKind;

  if (effectiveBackendKind === "tmux-window") {
    return {
      ...session,
      backendKind: "tmux-window",
      restoredFromBackendKind: undefined,
      tmuxControlSessionId: undefined,
      tmuxPaneId: undefined,
    };
  }

  if (effectiveBackendKind === "tmux-pane") {
    return {
      ...session,
      backendKind: "tmux-pane",
      restoredFromBackendKind: undefined,
      tmuxControlSessionId: undefined,
    };
  }

  return {
    ...session,
    backendKind: "local",
    restoredFromBackendKind: undefined,
    tmuxControlSessionId: undefined,
    tmuxConnectionKey: undefined,
    tmuxWindowId: undefined,
    tmuxPaneId: undefined,
  };
}

function getEffectiveBackendKind(session: TerminalSession): TerminalBackendKind {
  return session.restoredFromBackendKind ?? session.backendKind;
}

function isTmuxWindowSession(session: TerminalSession | undefined): boolean {
  if (!session) {
    return false;
  }

  return getEffectiveBackendKind(session) === "tmux-window";
}

function isTmuxPaneSession(session: TerminalSession | undefined): boolean {
  if (!session) {
    return false;
  }

  return getEffectiveBackendKind(session) === "tmux-pane";
}

export function normalizeRestoredTmuxState(
  snapshot: RestoredTmuxStateSnapshot
): RestoredTmuxStateNormalizationResult {
  const sessions: Record<string, TerminalSession> = {};
  for (const [id, session] of Object.entries(snapshot.sessions)) {
    sessions[id] = { ...session };
  }

  const nodes: Record<string, TreeNode> = {};
  for (const [id, node] of Object.entries(snapshot.nodes)) {
    nodes[id] = {
      ...node,
      children: dedupeIds(node.children),
    };
  }

  const projects: Record<string, Project> = {};
  for (const [id, project] of Object.entries(snapshot.projects)) {
    projects[id] = { ...project };
  }

  const layouts: Record<string, LayoutNode> = { ...snapshot.layouts };
  const liveTerminalIds = snapshot.liveTerminalIds ?? new Set<string>();
  /** A tmux tab is still usable when the transport carrying it is alive. */
  const hasLiveTransport = (session: TerminalSession): boolean => {
    const transportId = session.tmuxControlSessionId;
    return Boolean(transportId && liveTerminalIds.has(transportId));
  };
  let activeTerminalId = snapshot.activeTerminalId;
  let activeProjectId = snapshot.activeProjectId;
  let changed = false;

  for (const [sessionId, session] of Object.entries(sessions)) {
    if (liveTerminalIds.has(sessionId) && getEffectiveBackendKind(session) === "tmux-transport") {
      // The transport PTY survived, so the control session can be resumed.
      continue;
    }
    if (getEffectiveBackendKind(session) === "tmux-transport") {
      delete sessions[sessionId];
      delete layouts[sessionId];
      for (const [nodeId, node] of Object.entries(nodes)) {
        if (node.type === "terminal" && node.terminalId === sessionId) {
          removeTerminalNode(nodes, nodeId);
        }
      }
      if (activeTerminalId === sessionId) {
        activeTerminalId = null;
      }
      changed = true;
      continue;
    }
  }

  for (const [sessionId, session] of Object.entries(sessions)) {
    // Keep tmux tabs whose transport is still running fully wired up; clearing
    // their control-session id is what turns them into dead placeholders.
    if (hasLiveTransport(session)) {
      continue;
    }

    const cleared = clearRestoreMarker(session);
    if (cleared !== session) {
      sessions[sessionId] = cleared;
      changed = true;
    }
  }

  for (const [layoutId, layout] of Object.entries(layouts)) {
    const rootSession = sessions[layoutId];
    if (!rootSession || rootSession.backendKind !== "local") {
      continue;
    }

    const layoutTerminalIds = findTerminalIds(layout);
    if (layoutTerminalIds.includes(layoutId)) {
      continue;
    }

    const primaryTerminalId = layoutTerminalIds[0] ?? null;
    if (!primaryTerminalId || !sessions[primaryTerminalId]) {
      layouts[layoutId] = createLeaf(layoutId);
      changed = true;
      continue;
    }

    const primarySession = sessions[primaryTerminalId];
    sessions[primaryTerminalId] = clearRestoreMarker({
      ...primarySession,
      title: rootSession.title || primarySession.title,
      notes: rootSession.notes || primarySession.notes,
      cwd: primarySession.cwd ?? rootSession.cwd,
    });

    for (const [nodeId, node] of Object.entries(nodes)) {
      if (node.type === "terminal" && node.terminalId === layoutId) {
        nodes[nodeId] = {
          ...node,
          terminalId: primaryTerminalId,
          name: sessions[primaryTerminalId].title,
          hidden: false,
        };
      }
    }

    delete layouts[layoutId];
    layouts[primaryTerminalId] = layout;
    delete sessions[layoutId];
    if (activeTerminalId === layoutId) {
      activeTerminalId = primaryTerminalId;
    }
    changed = true;
  }

  for (const [nodeId, node] of Object.entries(nodes)) {
    if (node.type === "terminal") {
      if (!node.terminalId || !sessions[node.terminalId]) {
        removeTerminalNode(nodes, nodeId);
        changed = true;
        continue;
      }

      const owningLayoutId = findLayoutKeyForTerminal(layouts, node.terminalId);
      const session = sessions[node.terminalId];
      const owningRootSession = owningLayoutId ? sessions[owningLayoutId] : undefined;
      if (
        isTmuxPaneSession(session)
        && owningLayoutId
        && owningLayoutId !== node.terminalId
        && isTmuxWindowSession(owningRootSession)
      ) {
        removeTerminalNode(nodes, nodeId);
        changed = true;
        continue;
      }

      if (node.hidden) {
        nodes[nodeId] = {
          ...node,
          hidden: false,
        };
        changed = true;
      }
      continue;
    }

    const filteredChildren = dedupeIds(node.children)?.filter((childId) => {
      const child = nodes[childId];
      return Boolean(child) && child.parentId === nodeId;
    }) ?? [];
    if ((node.children ?? []).length !== filteredChildren.length) {
      nodes[nodeId] = {
        ...node,
        children: filteredChildren,
      };
      changed = true;
    }
  }

  const tabRootTerminalIds = new Set(
    Object.values(nodes)
      .filter((node) => node.type === "terminal" && node.terminalId && sessions[node.terminalId])
      .map((node) => node.terminalId as string)
  );

  for (const [layoutId, layout] of Object.entries(layouts)) {
    if (!tabRootTerminalIds.has(layoutId) || !sessions[layoutId]) {
      delete layouts[layoutId];
      changed = true;
      continue;
    }

    const prunedLayout = pruneLayoutTree(layout, sessions);
    if (!prunedLayout) {
      layouts[layoutId] = createLeaf(layoutId);
      changed = true;
      continue;
    }

    if (prunedLayout !== layout) {
      layouts[layoutId] = prunedLayout;
      changed = true;
    }
  }

  for (const tabRootTerminalId of tabRootTerminalIds) {
    if (!layouts[tabRootTerminalId]) {
      layouts[tabRootTerminalId] = createLeaf(tabRootTerminalId);
      changed = true;
    }
  }

  const keepSessionIds = new Set<string>();
  for (const tabRootTerminalId of tabRootTerminalIds) {
    keepSessionIds.add(tabRootTerminalId);
    const layout = layouts[tabRootTerminalId];
    for (const terminalId of findTerminalIds(layout)) {
      keepSessionIds.add(terminalId);
    }
  }

  for (const sessionId of Object.keys(sessions)) {
    if (!keepSessionIds.has(sessionId)) {
      delete sessions[sessionId];
      if (activeTerminalId === sessionId) {
        activeTerminalId = null;
      }
      changed = true;
    }
  }

  const visibleRefsByProject = new Map<string, string[]>();
  const orderedProjectIds = snapshot.projectOrder.filter((projectId) => Boolean(projects[projectId]));
  for (const projectId of orderedProjectIds) {
    const project = projects[projectId];
    if (!project) {
      continue;
    }
    visibleRefsByProject.set(
      projectId,
      collectVisibleTerminalRefs(nodes, project.rootGroupId, sessions).map((ref) => ref.terminalId)
    );
  }

  const visibleProjectIds = orderedProjectIds.filter(
    (projectId) => (visibleRefsByProject.get(projectId) ?? []).length > 0
  );

  if (!activeProjectId || !projects[activeProjectId] || (visibleProjectIds.length > 0 && (visibleRefsByProject.get(activeProjectId) ?? []).length === 0)) {
    const nextProjectId = visibleProjectIds[0] ?? orderedProjectIds[0] ?? null;
    if (activeProjectId !== nextProjectId) {
      activeProjectId = nextProjectId;
      changed = true;
    }
  }

  if (activeTerminalId && !sessions[activeTerminalId]) {
    activeTerminalId = null;
    changed = true;
  }

  if (activeTerminalId) {
    const owningProjectId = findProjectIdForTerminal(
      projects,
      orderedProjectIds,
      nodes,
      sessions,
      findLayoutKeyForTerminal(layouts, activeTerminalId) ?? activeTerminalId
    );
    if (owningProjectId && owningProjectId !== activeProjectId) {
      activeProjectId = owningProjectId;
      changed = true;
    }
  }

  if (!activeTerminalId && activeProjectId) {
    const visibleTerminalIds = visibleRefsByProject.get(activeProjectId) ?? [];
    const nextActiveTerminalId = visibleTerminalIds[0] ?? null;
    if (activeTerminalId !== nextActiveTerminalId) {
      activeTerminalId = nextActiveTerminalId;
      changed = true;
    }
  }

  return {
    sessions,
    activeTerminalId,
    projects,
    nodes,
    activeProjectId,
    projectOrder: orderedProjectIds,
    layouts,
    changed,
  };
}
