import { describe, expect, it } from "vitest";
import { leaf } from "../../test/helpers";
import { findTerminalIds } from "../layoutUtils";
import { normalizeRestoredTmuxState } from "../restoredTmuxState";

describe("restoredTmuxState", () => {
  it("preserves restored tmux windows as disconnected placeholders and removes transport cruft", () => {
    const result = normalizeRestoredTmuxState({
      // An explicit empty set: we asked what was running and the answer was
      // nothing. Omitting it would mean "could not ask", which keeps the tabs.
      liveTerminalIds: new Set<string>(),
      sessions: {
        transport: {
          id: "transport",
          title: "A",
          notes: "transport notes",
          hasDetectedActivity: false,
          lastUserInputAt: 0,
          lastOutputAt: 0,
          isNeedsAttention: false,
          isPossiblyDone: false,
          isLongInactive: false,
          isRecentlyFocused: false,
          backendKind: "local",
          restoredFromBackendKind: "tmux-transport",
        },
        window: {
          id: "window",
          title: "A",
          notes: "hello",
          hasDetectedActivity: false,
          lastUserInputAt: 0,
          lastOutputAt: 0,
          isNeedsAttention: false,
          isPossiblyDone: false,
          isLongInactive: false,
          isRecentlyFocused: false,
          backendKind: "tmux-window",
          restoredFromBackendKind: "tmux-window",
          tmuxWindowId: "@1",
        },
        pane: {
          id: "pane",
          title: "bash",
          notes: "",
          cwd: "/tmp",
          hasDetectedActivity: false,
          lastUserInputAt: 0,
          lastOutputAt: 0,
          isNeedsAttention: false,
          isPossiblyDone: false,
          isLongInactive: false,
          isRecentlyFocused: false,
          backendKind: "tmux-pane",
          restoredFromBackendKind: "tmux-pane",
          tmuxWindowId: "@1",
          tmuxPaneId: "%1",
        },
      },
      activeTerminalId: "pane",
      projects: {
        p1: {
          id: "p1",
          name: "Project",
          cwd: "/tmp",
          rootGroupId: "root",
          expanded: true,
        },
      },
      nodes: {
        root: {
          id: "root",
          type: "group",
          name: "Root",
          parentId: null,
          children: ["transport-node", "window-node"],
        },
        "transport-node": {
          id: "transport-node",
          type: "terminal",
          name: "A",
          terminalId: "transport",
          parentId: "root",
          hidden: true,
        },
        "window-node": {
          id: "window-node",
          type: "terminal",
          name: "A",
          terminalId: "window",
          parentId: "root",
        },
        "pane-node": {
          id: "pane-node",
          type: "terminal",
          name: "bash",
          terminalId: "pane",
          parentId: "root",
        },
      },
      activeProjectId: "p1",
      projectOrder: ["p1"],
      layouts: {
        transport: leaf("transport"),
        window: leaf("pane"),
      },
    });

    expect(result.sessions.transport).toBeUndefined();
    expect(result.sessions.window).toBeDefined();
    expect(result.sessions.pane).toBeDefined();
    expect(result.sessions.window.backendKind).toBe("tmux-window");
    expect(result.sessions.window.tmuxWindowId).toBe("@1");
    expect(result.sessions.window.restoredFromBackendKind).toBeUndefined();
    expect(result.sessions.window.notes).toBe("hello");
    expect(result.sessions.pane.backendKind).toBe("tmux-pane");
    expect(result.sessions.pane.tmuxWindowId).toBe("@1");
    expect(result.sessions.pane.tmuxPaneId).toBe("%1");
    expect(result.sessions.pane.restoredFromBackendKind).toBeUndefined();

    expect(result.nodes["transport-node"]).toBeUndefined();
    expect(result.nodes["pane-node"]).toBeUndefined();
    expect(result.nodes["window-node"].terminalId).toBe("window");
    expect(result.nodes.root.children).toEqual(["window-node"]);

    expect(result.layouts.window).toBeDefined();
    expect(findTerminalIds(result.layouts.window)).toEqual(["pane"]);
    expect(result.layouts.pane).toBeUndefined();
    expect(result.activeTerminalId).toBe("pane");
    expect(result.activeProjectId).toBe("p1");
  });

  it("drops orphan restored tabs and falls back to the first visible project terminal", () => {
    const result = normalizeRestoredTmuxState({
      sessions: {
        orphan: {
          id: "orphan",
          title: "Old",
          notes: "",
          hasDetectedActivity: false,
          lastUserInputAt: 0,
          lastOutputAt: 0,
          isNeedsAttention: false,
          isPossiblyDone: false,
          isLongInactive: false,
          isRecentlyFocused: false,
          backendKind: "local",
        },
        t1: {
          id: "t1",
          title: "A",
          notes: "",
          hasDetectedActivity: false,
          lastUserInputAt: 0,
          lastOutputAt: 0,
          isNeedsAttention: false,
          isPossiblyDone: false,
          isLongInactive: false,
          isRecentlyFocused: false,
          backendKind: "local",
        },
      },
      activeTerminalId: "orphan",
      projects: {
        p1: {
          id: "p1",
          name: "Project",
          cwd: "/tmp",
          rootGroupId: "root",
          expanded: true,
        },
      },
      nodes: {
        root: {
          id: "root",
          type: "group",
          name: "Root",
          parentId: null,
          children: ["node-1"],
        },
        "node-1": {
          id: "node-1",
          type: "terminal",
          name: "A",
          terminalId: "t1",
          parentId: "root",
        },
      },
      activeProjectId: "p1",
      projectOrder: ["p1"],
      layouts: {
        orphan: leaf("orphan"),
        t1: leaf("t1"),
      },
    });

    expect(result.sessions.orphan).toBeUndefined();
    expect(result.layouts.orphan).toBeUndefined();
    expect(result.activeTerminalId).toBe("t1");
    expect(result.activeProjectId).toBe("p1");
  });

  it("removes stale cross-project child references using the node parent as source of truth", () => {
    const result = normalizeRestoredTmuxState({
      sessions: {
        t1: {
          id: "t1",
          title: "Moved",
          notes: "",
          hasDetectedActivity: false,
          lastUserInputAt: 0,
          lastOutputAt: 0,
          isNeedsAttention: false,
          isPossiblyDone: false,
          isLongInactive: false,
          isRecentlyFocused: false,
          backendKind: "local",
        },
      },
      activeTerminalId: "t1",
      projects: {
        p1: {
          id: "p1",
          name: "Old",
          cwd: "/tmp",
          rootGroupId: "root-a",
          expanded: true,
        },
        p2: {
          id: "p2",
          name: "New",
          cwd: "/tmp",
          rootGroupId: "root-b",
          expanded: true,
        },
      },
      nodes: {
        "root-a": {
          id: "root-a",
          type: "group",
          name: "Root",
          parentId: null,
          children: ["node-1"],
        },
        "root-b": {
          id: "root-b",
          type: "group",
          name: "Root",
          parentId: null,
          children: ["node-1"],
        },
        "node-1": {
          id: "node-1",
          type: "terminal",
          name: "Moved",
          terminalId: "t1",
          parentId: "root-b",
        },
      },
      activeProjectId: "p1",
      projectOrder: ["p1", "p2"],
      layouts: {
        t1: leaf("t1"),
      },
    });

    expect(result.nodes["root-a"].children).toEqual([]);
    expect(result.nodes["root-b"].children).toEqual(["node-1"]);
    expect(result.activeProjectId).toBe("p2");
  });

  it("collapses legacy rootless layouts even when the old tmux marker is gone", () => {
    const result = normalizeRestoredTmuxState({
      sessions: {
        root: {
          id: "root",
          title: "A",
          notes: "legacy",
          hasDetectedActivity: false,
          lastUserInputAt: 0,
          lastOutputAt: 0,
          isNeedsAttention: false,
          isPossiblyDone: false,
          isLongInactive: false,
          isRecentlyFocused: false,
          backendKind: "local",
        },
        pane: {
          id: "pane",
          title: "bash",
          notes: "",
          hasDetectedActivity: false,
          lastUserInputAt: 0,
          lastOutputAt: 0,
          isNeedsAttention: false,
          isPossiblyDone: false,
          isLongInactive: false,
          isRecentlyFocused: false,
          backendKind: "local",
        },
      },
      activeTerminalId: "root",
      projects: {
        p1: {
          id: "p1",
          name: "Project",
          cwd: "/tmp",
          rootGroupId: "root-group",
          expanded: true,
        },
      },
      nodes: {
        "root-group": {
          id: "root-group",
          type: "group",
          name: "Root",
          parentId: null,
          children: ["node-1"],
        },
        "node-1": {
          id: "node-1",
          type: "terminal",
          name: "A",
          terminalId: "root",
          parentId: "root-group",
        },
      },
      activeProjectId: "p1",
      projectOrder: ["p1"],
      layouts: {
        root: leaf("pane"),
      },
    });

    expect(result.sessions.root).toBeUndefined();
    expect(result.sessions.pane.title).toBe("A");
    expect(result.sessions.pane.notes).toBe("legacy");
    expect(result.nodes["node-1"].terminalId).toBe("pane");
    expect(result.layouts.root).toBeUndefined();
    expect(result.layouts.pane).toBeDefined();
    expect(result.activeTerminalId).toBe("pane");
  });
});
