import { describe, expect, it } from "vitest";
import { planReorderSequence } from "../dragReorderPlan";

/** Apply the plan to a list, the way the store's reorder does. */
function applyPlan(children: string[], steps: ReturnType<typeof planReorderSequence>): string[] {
  let result = [...children];
  for (const step of steps) {
    result = result.filter((id) => id !== step.nodeId);
    const index = result.indexOf(step.targetNodeId);
    result.splice(step.position === "before" ? index : index + 1, 0, step.nodeId);
  }
  return result;
}

describe("planReorderSequence", () => {
  it("lands a selection together, in order, below the target", () => {
    expect(applyPlan(["a", "b", "c", "d", "e"], planReorderSequence(["a", "c"], "d", "after")))
      .toEqual(["b", "d", "a", "c", "e"]);
  });

  it("lands a selection together, in order, above the target", () => {
    // The direction the list grows in flips between before and after, which is
    // exactly what repeating a single-row reorder gets wrong.
    expect(applyPlan(["a", "b", "c", "d", "e"], planReorderSequence(["a", "c"], "e", "before")))
      .toEqual(["b", "d", "a", "c", "e"]);
  });

  it("keeps a single row behaving as it always did", () => {
    expect(planReorderSequence(["a"], "c", "before")).toEqual([
      { nodeId: "a", targetNodeId: "c", position: "before" },
    ]);
  });

  it("does nothing when dropped on one of its own rows", () => {
    expect(planReorderSequence(["a", "b"], "b", "after")).toEqual([]);
  });

  it("moves a selection that is already contiguous without scrambling it", () => {
    expect(applyPlan(["a", "b", "c", "d"], planReorderSequence(["b", "c"], "a", "before")))
      .toEqual(["b", "c", "a", "d"]);
  });
});
