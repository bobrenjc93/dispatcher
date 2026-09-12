/**
 * Dropping several rows at once.
 *
 * A reorder moves one child relative to one other child, which is all a single
 * drag ever needed. Dragging a selection has to end with those rows together,
 * at the drop point, in the order they already had — and doing that by
 * repeating "put this one before the target" gets the order backwards, while
 * repeating "after" gets it backwards the other way.
 *
 * So only the first row is placed against the drop target. Every one after it
 * is placed after the row that just landed, which keeps them contiguous and in
 * order without having to reason about which direction the list grows in.
 */

export interface ReorderStep {
  nodeId: string;
  targetNodeId: string;
  position: "before" | "after";
}

export function planReorderSequence(
  nodeIds: readonly string[],
  targetNodeId: string,
  position: "before" | "after"
): ReorderStep[] {
  // Dropping a selection onto one of its own rows has no meaning, and acting
  // on it would shuffle the rest around that row for nothing.
  if (nodeIds.includes(targetNodeId)) {
    return [];
  }

  const steps: ReorderStep[] = [];
  let anchor = targetNodeId;
  let anchorPosition = position;
  for (const nodeId of nodeIds) {
    steps.push({ nodeId, targetNodeId: anchor, position: anchorPosition });
    anchor = nodeId;
    anchorPosition = "after";
  }
  return steps;
}
