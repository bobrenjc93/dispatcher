import type { TreeNode, Project } from "../types/project";
import type { TerminalSession } from "../types/terminal";

export interface VisibleTerminalRef {
  nodeId: string;
  parentNodeId: string | null;
  terminalId: string;
}

export interface DisconnectedTmuxWindowPlaceholderRef {
  nodeId: string;
  node: TreeNode;
  terminalId: string;
  parentNodeId: string | null;
  projectId: string | null;
}

function getOrderedProjectIds(
  projects: Record<string, Project>,
  projectOrder: string[]
): string[] {
  return projectOrder.length > 0 ? projectOrder : Object.keys(projects);
}

export function collectVisibleTerminalRefs(
  nodes: Record<string, TreeNode>,
  rootNodeId: string,
  sessions: Record<string, TerminalSession>
): VisibleTerminalRef[] {
  const refs: VisibleTerminalRef[] = [];

  function visit(nodeId: string, parentNodeId: string | null) {
    const node = nodes[nodeId];
    if (!node || node.hidden) {
      return;
    }

    if (node.type === "terminal" && node.terminalId && sessions[node.terminalId]) {
      refs.push({
        nodeId,
        parentNodeId,
        terminalId: node.terminalId,
      });
      return;
    }

    if (node.type === "group" && node.children) {
      for (const childId of node.children) {
        visit(childId, nodeId);
      }
    }
  }

  const root = nodes[rootNodeId];
  if (!root?.children) {
    return refs;
  }

  for (const childId of root.children) {
    visit(childId, rootNodeId);
  }

  return refs;
}

export function findNodeByTerminalId(
  nodes: Record<string, TreeNode>,
  terminalId: string
): { nodeId: string; node: TreeNode } | null {
  for (const [nodeId, node] of Object.entries(nodes)) {
    if (node.type === "terminal" && node.terminalId === terminalId) {
      return { nodeId, node };
    }
  }
  return null;
}

export function findProjectIdForNode(
  projects: Record<string, Project>,
  projectOrder: string[],
  nodes: Record<string, TreeNode>,
  nodeId: string
): string | null {
  const rootToProjectId = new Map<string, string>();
  for (const projectId of getOrderedProjectIds(projects, projectOrder)) {
    const project = projects[projectId];
    if (project) {
      rootToProjectId.set(project.rootGroupId, projectId);
    }
  }

  const visited = new Set<string>();
  let currentNodeId: string | null = nodeId;
  while (currentNodeId && !visited.has(currentNodeId)) {
    visited.add(currentNodeId);
    const matchingProjectId = rootToProjectId.get(currentNodeId);
    if (matchingProjectId) {
      return matchingProjectId;
    }
    currentNodeId = nodes[currentNodeId]?.parentId ?? null;
  }

  return null;
}

export function findProjectIdForTerminal(
  projects: Record<string, Project>,
  projectOrder: string[],
  nodes: Record<string, TreeNode>,
  sessions: Record<string, TerminalSession>,
  terminalId: string
): string | null {
  const nodeEntry = findNodeByTerminalId(nodes, terminalId);
  if (nodeEntry) {
    const projectId = findProjectIdForNode(projects, projectOrder, nodes, nodeEntry.nodeId);
    if (projectId) {
      return projectId;
    }
  }

  for (const projectId of getOrderedProjectIds(projects, projectOrder)) {
    const project = projects[projectId];
    if (!project) {
      continue;
    }

    const refs = collectVisibleTerminalRefs(nodes, project.rootGroupId, sessions);
    if (refs.some((ref) => ref.terminalId === terminalId)) {
      return projectId;
    }
  }

  return null;
}

export function findDisconnectedTmuxWindowPlaceholder(
  projects: Record<string, Project>,
  projectOrder: string[],
  nodes: Record<string, TreeNode>,
  sessions: Record<string, TerminalSession>,
  windowId: string,
  options?: {
    parentNodeId?: string;
    projectId?: string;
    title?: string;
    connectionKey?: string;
  }
): DisconnectedTmuxWindowPlaceholderRef | null {
  const candidates: DisconnectedTmuxWindowPlaceholderRef[] = [];

  for (const [nodeId, node] of Object.entries(nodes)) {
    if (node.type !== "terminal" || !node.terminalId) {
      continue;
    }

    const session = sessions[node.terminalId];
    if (
      !session
      || session.backendKind !== "tmux-window"
      || Boolean(session.tmuxControlSessionId)
      || session.tmuxWindowId !== windowId
    ) {
      continue;
    }

    candidates.push({
      nodeId,
      node,
      terminalId: node.terminalId,
      parentNodeId: node.parentId,
      projectId: findProjectIdForNode(projects, projectOrder, nodes, nodeId),
    });
  }

  if (candidates.length === 0) {
    return null;
  }

  const rankByPlacement = (rankedCandidates: DisconnectedTmuxWindowPlaceholderRef[]) => {
    if (options?.parentNodeId) {
      const sameParentCandidate = rankedCandidates.find(
        (candidate) => candidate.parentNodeId === options.parentNodeId
      );
      if (sameParentCandidate) {
        return sameParentCandidate;
      }
    }
    if (options?.projectId) {
      const sameProjectCandidate = rankedCandidates.find(
        (candidate) => candidate.projectId === options.projectId
      );
      if (sameProjectCandidate) {
        return sameProjectCandidate;
      }
    }
    return rankedCandidates[0] ?? null;
  };

  // Prefer the durable tmux server/session identity over all mutable metadata.
  // A title can legitimately change while Dispatcher is closed, but a known
  // identity mismatch means this is an unrelated server that recycled @N.
  if (options?.connectionKey) {
    const identityMatches = candidates.filter((candidate) =>
      sessions[candidate.terminalId]?.tmuxConnectionKey === options.connectionKey
    );
    if (identityMatches.length > 0) {
      const titleAndIdentityMatches = options.title
        ? identityMatches.filter((candidate) => {
            const session = sessions[candidate.terminalId];
            return session?.title === options.title || candidate.node.name === options.title;
          })
        : [];
      return rankByPlacement(
        titleAndIdentityMatches.length > 0 ? titleAndIdentityMatches : identityMatches
      );
    }
  }

  // Legacy placeholders have no durable identity. Never match one whose saved
  // title disagrees: IDs alone are not safe because tmux recycles them. Exact
  // title must outrank placement; the previous same-parent-first behavior is
  // what caused unrelated historical tabs in one sidebar group to be adopted.
  const legacyCandidates = candidates.filter((candidate) =>
    !sessions[candidate.terminalId]?.tmuxConnectionKey
  );
  if (options?.title) {
    const titleMatches = legacyCandidates.filter((candidate) => {
      const session = sessions[candidate.terminalId];
      return session?.title === options.title || candidate.node.name === options.title;
    });
    if (titleMatches.length > 0) {
      return rankByPlacement(titleMatches);
    }
  }

  return null;
}

/**
 * Where a newly opened terminal belongs among its siblings.
 *
 * Directly after the tab it was opened from. A new terminal belongs next to
 * the one whose work prompted it — appending sends it past every other tab,
 * which on a long list means hunting for the thing you just created.
 *
 * Returns null when the source has no place in this list — opened from a
 * different project, or with nothing focused at all — leaving the end as the
 * only sensible answer.
 */
export function resolveSiblingInsertIndex(
  siblingIds: readonly string[],
  nodes: Record<string, TreeNode>,
  sourceTerminalId: string | undefined
): number | null {
  if (!sourceTerminalId) {
    return null;
  }

  const sourceIndex = siblingIds.findIndex((childId) => {
    const child = nodes[childId];
    return child?.type === "terminal" && child.terminalId === sourceTerminalId;
  });

  return sourceIndex >= 0 ? sourceIndex + 1 : null;
}
