export interface TmuxWindowOrderEntry {
  windowId: string;
  nodeId: string;
}

export function buildPreferredTmuxWindowOrder(options: {
  currentChildren: readonly string[];
  windows: readonly TmuxWindowOrderEntry[];
  snapshotWindowOrder: readonly string[];
}): string[] {
  const windowIdByNodeId = new Map(
    options.windows.map((window) => [window.nodeId, window.windowId] as const)
  );

  const preservedOrder = options.currentChildren
    .map((childId) => windowIdByNodeId.get(childId))
    .filter((windowId): windowId is string => Boolean(windowId));

  const seen = new Set(preservedOrder);
  const appended = options.snapshotWindowOrder.filter((windowId) => !seen.has(windowId));
  return [...preservedOrder, ...appended];
}

export function resolveAdjacentTmuxWindowAfterClose(options: {
  windowOrder: readonly string[];
  closingWindowId: string;
  availableWindowIds: ReadonlySet<string>;
}): string | null {
  const orderedWindowIds: string[] = [];
  const seenWindowIds = new Set<string>();

  for (const windowId of options.windowOrder) {
    if (seenWindowIds.has(windowId)) {
      continue;
    }

    if (windowId === options.closingWindowId || options.availableWindowIds.has(windowId)) {
      orderedWindowIds.push(windowId);
      seenWindowIds.add(windowId);
    }
  }

  const closingIndex = orderedWindowIds.indexOf(options.closingWindowId);
  if (closingIndex === -1) {
    return orderedWindowIds.find((windowId) => options.availableWindowIds.has(windowId)) ?? null;
  }

  // Match Dispatcher sidebar close behavior: closing an active tab focuses the
  // next tab down, and closing the last tab falls back to the previous one.
  for (let index = closingIndex + 1; index < orderedWindowIds.length; index += 1) {
    const windowId = orderedWindowIds[index];
    if (options.availableWindowIds.has(windowId)) {
      return windowId;
    }
  }

  for (let index = closingIndex - 1; index >= 0; index -= 1) {
    const windowId = orderedWindowIds[index];
    if (options.availableWindowIds.has(windowId)) {
      return windowId;
    }
  }

  return null;
}

export function mergeTmuxWindowNodesIntoChildren(options: {
  currentChildren: readonly string[];
  transportNodeId: string;
  preferredWindowNodeOrder: readonly string[];
  missingWindowPlacement?: "after-anchor" | "append";
}): string[] {
  const currentChildSet = new Set(options.currentChildren);
  const missingWindowNodeIds = options.preferredWindowNodeOrder.filter(
    (nodeId) => !currentChildSet.has(nodeId)
  );

  if (missingWindowNodeIds.length === 0) {
    return [...options.currentChildren];
  }

  if (options.missingWindowPlacement === "append") {
    return [...options.currentChildren, ...missingWindowNodeIds];
  }

  const result = [...options.currentChildren];
  let anchorNodeId = result.includes(options.transportNodeId)
    ? options.transportNodeId
    : null;
  for (const nodeId of options.preferredWindowNodeOrder) {
    if (result.includes(nodeId)) {
      anchorNodeId = nodeId;
      continue;
    }

    const anchorIndex = anchorNodeId ? result.indexOf(anchorNodeId) : -1;
    const insertIndex = anchorIndex === -1 ? result.length : anchorIndex + 1;
    result.splice(insertIndex, 0, nodeId);
    anchorNodeId = nodeId;
  }
  return result;
}

export function reconcileTmuxWindowNodePlacements(options: {
  currentChildrenByParentId: Record<string, readonly string[]>;
  nodeParentByNodeId: Record<string, string | null | undefined>;
  windowNodeIds: readonly string[];
  preferredWindowNodeOrder: readonly string[];
  transportNodeId: string;
  missingWindowPlacement?: "after-anchor" | "append";
}): Record<string, string[]> {
  const windowNodeIdSet = new Set(options.windowNodeIds);
  const parentIds = new Set(Object.keys(options.currentChildrenByParentId));

  for (const nodeId of options.windowNodeIds) {
    const parentNodeId = options.nodeParentByNodeId[nodeId];
    if (parentNodeId) {
      parentIds.add(parentNodeId);
    }
  }

  const nextChildrenByParentId: Record<string, string[]> = {};
  for (const parentNodeId of parentIds) {
    const currentChildren = options.currentChildrenByParentId[parentNodeId] ?? [];
    const cleanedChildren = currentChildren.filter((childId) => {
      if (!windowNodeIdSet.has(childId)) {
        return true;
      }
      return options.nodeParentByNodeId[childId] === parentNodeId;
    });
    const preferredWindowNodeOrder = options.preferredWindowNodeOrder.filter(
      (nodeId) => options.nodeParentByNodeId[nodeId] === parentNodeId
    );

    nextChildrenByParentId[parentNodeId] = mergeTmuxWindowNodesIntoChildren({
      currentChildren: cleanedChildren,
      transportNodeId: options.transportNodeId,
      preferredWindowNodeOrder,
      missingWindowPlacement: options.missingWindowPlacement,
    });
  }

  return nextChildrenByParentId;
}
