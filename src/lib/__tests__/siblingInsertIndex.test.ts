import { describe, expect, it } from "vitest";
import { resolveSiblingInsertIndex } from "../treeUtils";
import type { TreeNode } from "../../types/project";

const nodes: Record<string, TreeNode> = {
  "n-a": { id: "n-a", type: "terminal", parentId: "root", terminalId: "a" } as never,
  "n-b": { id: "n-b", type: "terminal", parentId: "root", terminalId: "b" } as never,
  "n-c": { id: "n-c", type: "terminal", parentId: "root", terminalId: "c" } as never,
  "n-group": { id: "n-group", type: "group", parentId: "root", children: [] } as never,
};
const siblings = ["n-a", "n-b", "n-c"];

describe("where a new terminal goes", () => {
  it("lands directly below the tab it was opened from", () => {
    expect(resolveSiblingInsertIndex(siblings, nodes, "b")).toBe(2);
  });

  it("lands below the first tab, not at the end of the list", () => {
    // The regression: a new terminal used to be appended, so opening one from
    // the top of a long list put it out of sight at the bottom.
    expect(resolveSiblingInsertIndex(siblings, nodes, "a")).toBe(1);
  });

  it("goes to the end when the last tab is the source", () => {
    expect(resolveSiblingInsertIndex(siblings, nodes, "c")).toBe(3);
  });

  it("goes to the end when nothing is focused", () => {
    expect(resolveSiblingInsertIndex(siblings, nodes, undefined)).toBeNull();
  });

  it("goes to the end when the source belongs to a different list", () => {
    // Opened from another project: it has no position here to sit after.
    expect(resolveSiblingInsertIndex(siblings, nodes, "elsewhere")).toBeNull();
  });

  it("ignores a group that happens to share the id shape", () => {
    expect(resolveSiblingInsertIndex(["n-group", ...siblings], nodes, "a")).toBe(2);
  });
});
