import { describe, expect, it } from "vitest";
import {
  buildPreferredTmuxWindowOrder,
  mergeTmuxWindowNodesIntoChildren,
  reconcileTmuxWindowNodePlacements,
  resolveAdjacentTmuxWindowAfterClose,
} from "../tmuxWindowOrder";

describe("tmuxWindowOrder", () => {
  it("preserves the existing sidebar order for restored windows", () => {
    expect(buildPreferredTmuxWindowOrder({
      currentChildren: ["node-b", "node-a", "local-shell"],
      windows: [
        { windowId: "@1", nodeId: "node-a" },
        { windowId: "@2", nodeId: "node-b" },
        { windowId: "@3", nodeId: "node-c" },
      ],
      snapshotWindowOrder: ["@1", "@2", "@3"],
    })).toEqual(["@2", "@1", "@3"]);
  });

  it("resolves close focus to the next tmux window, then the previous one", () => {
    expect(resolveAdjacentTmuxWindowAfterClose({
      windowOrder: ["@1", "@2", "@3"],
      closingWindowId: "@2",
      availableWindowIds: new Set(["@1", "@3"]),
    })).toBe("@3");

    expect(resolveAdjacentTmuxWindowAfterClose({
      windowOrder: ["@1", "@2", "@3"],
      closingWindowId: "@3",
      availableWindowIds: new Set(["@1", "@2"]),
    })).toBe("@2");
  });

  it("skips stale window-order entries when resolving close focus", () => {
    expect(resolveAdjacentTmuxWindowAfterClose({
      windowOrder: ["@1", "@2", "@3", "@4"],
      closingWindowId: "@2",
      availableWindowIds: new Set(["@1", "@4"]),
    })).toBe("@4");
  });

  it("keeps existing window nodes in place and appends only missing ones", () => {
    expect(mergeTmuxWindowNodesIntoChildren({
      currentChildren: ["transport", "node-b", "node-a", "local-shell"],
      transportNodeId: "transport",
      preferredWindowNodeOrder: ["node-b", "node-a", "node-c"],
    })).toEqual(["transport", "node-b", "node-a", "node-c", "local-shell"]);
  });

  it("inserts fresh tmux windows after the hidden transport node", () => {
    expect(mergeTmuxWindowNodesIntoChildren({
      currentChildren: ["before", "transport", "after"],
      transportNodeId: "transport",
      preferredWindowNodeOrder: ["node-a", "node-b"],
    })).toEqual(["before", "transport", "node-a", "node-b", "after"]);
  });

  it("inserts a fresh tmux window after its focused predecessor", () => {
    expect(mergeTmuxWindowNodesIntoChildren({
      currentChildren: ["transport", "node-a", "node-b", "local-shell"],
      transportNodeId: "transport",
      preferredWindowNodeOrder: ["node-a", "node-c", "node-b"],
    })).toEqual(["transport", "node-a", "node-c", "node-b", "local-shell"]);
  });

  it("can append missing restored tmux windows without moving existing sidebar entries", () => {
    expect(mergeTmuxWindowNodesIntoChildren({
      currentChildren: ["transport", "node-b", "local-shell"],
      transportNodeId: "transport",
      preferredWindowNodeOrder: ["node-b", "node-c"],
      missingWindowPlacement: "append",
    })).toEqual(["transport", "node-b", "local-shell", "node-c"]);
  });

  it("removes stale cross-project references when a tmux window node was moved", () => {
    expect(reconcileTmuxWindowNodePlacements({
      currentChildrenByParentId: {
        "group-a": ["transport", "node-a", "node-b", "local-a"],
        "group-b": ["local-b", "node-b"],
      },
      nodeParentByNodeId: {
        "node-a": "group-a",
        "node-b": "group-b",
      },
      windowNodeIds: ["node-a", "node-b"],
      preferredWindowNodeOrder: ["node-a", "node-b"],
      transportNodeId: "transport",
    })).toEqual({
      "group-a": ["transport", "node-a", "local-a"],
      "group-b": ["local-b", "node-b"],
    });
  });

  it("inserts a missing tmux window only under its authoritative parent", () => {
    expect(reconcileTmuxWindowNodePlacements({
      currentChildrenByParentId: {
        "group-a": ["transport", "node-a"],
        "group-b": [],
      },
      nodeParentByNodeId: {
        "node-a": "group-a",
        "node-b": "group-b",
      },
      windowNodeIds: ["node-a", "node-b"],
      preferredWindowNodeOrder: ["node-a", "node-b"],
      transportNodeId: "transport",
    })).toEqual({
      "group-a": ["transport", "node-a"],
      "group-b": ["node-b"],
    });
  });
});
