import { beforeEach, describe, expect, it, vi } from "vitest";

const { closeTerminalMock, disposeTerminalInstanceMock } = vi.hoisted(() => ({
  closeTerminalMock: vi.fn(async () => {}),
  disposeTerminalInstanceMock: vi.fn(),
}));

vi.mock("../tauriCommands", () => ({
  appendDebugLog: vi.fn(async () => {}),
  closeTerminal: closeTerminalMock,
  writeTerminal: vi.fn(async () => {}),
}));

vi.mock("../../hooks/useTerminalBridge", () => ({
  disposeTerminalInstance: disposeTerminalInstanceMock,
  ensureTerminalFrontend: vi.fn(),
  ensureTerminalOutputChannel: vi.fn(),
  focusTerminalInstance: vi.fn(),
  getTerminalCellSize: vi.fn(() => ({ width: 8, height: 16 })),
  getTerminalViewportSize: vi.fn(() => ({ width: 640, height: 384 })),
  queueTerminalOutput: vi.fn(),
  syncTerminalFrontendSize: vi.fn(),
}));

import { useLayoutStore } from "../../stores/useLayoutStore";
import { useProjectStore } from "../../stores/useProjectStore";
import { useTerminalStore } from "../../stores/useTerminalStore";
import { CLOSED_TAB_TTL_MS, hiddenWindowIdsForConnection, listClosedTabs } from "../closedTabs";
import {
  detachClosedLocalTerminals,
  reapExpiredClosedLocalTabs,
  rememberClosedLocalTab,
  reopenLastClosedTab,
} from "../localClosedTabs";

function seedProject(tabIds: string[]) {
  useProjectStore.setState({
    projects: {
      p1: { id: "p1", name: "work", cwd: "/tmp", rootGroupId: "root", expanded: true },
    },
    projectOrder: ["p1"],
    activeProjectId: "p1",
    nodes: {
      root: { id: "root", type: "group", name: "work", parentId: null, children: tabIds.map((id) => `node-${id}`) },
      ...Object.fromEntries(
        tabIds.map((id) => [
          `node-${id}`,
          { id: `node-${id}`, type: "terminal" as const, name: id, terminalId: id, parentId: "root" },
        ])
      ),
    },
  });
  useLayoutStore.setState({ layouts: {} });
  useTerminalStore.setState({ sessions: {}, activeTerminalId: null });
  for (const id of tabIds) {
    useTerminalStore.getState().addSession(id, `tab ${id}`, "/tmp");
    useLayoutStore.getState().initLayout(id, id);
  }
}

/** What App does on ⌘W for a sole pane, minus the focus handling. */
function closeTab(tabId: string) {
  const kept = rememberClosedLocalTab(tabId, "p1");
  expect(kept).not.toBeNull();
  useLayoutStore.getState().removeLayout(tabId);
  detachClosedLocalTerminals(kept!);
  useProjectStore.getState().removeChildFromNode("root", `node-${tabId}`);
  useProjectStore.getState().removeNode(`node-${tabId}`);
  return kept!;
}

function sidebarTabIds(): string[] {
  const { nodes } = useProjectStore.getState();
  return (nodes.root?.children ?? []).map((nodeId) => nodes[nodeId]?.terminalId ?? "?");
}

describe("closing and reopening a local tab", () => {
  beforeEach(() => {
    window.localStorage.clear();
    closeTerminalMock.mockClear();
    disposeTerminalInstanceMock.mockClear();
  });

  it("leaves the shell running when the tab closes", () => {
    // What made ⇧⌘T useless for local tabs: closing killed the PTY on the
    // spot, so there was never anything to bring back.
    seedProject(["a", "b"]);
    closeTab("b");

    expect(closeTerminalMock).not.toHaveBeenCalled();
    expect(disposeTerminalInstanceMock).toHaveBeenCalledWith("b");
    expect(useTerminalStore.getState().sessions.b).toBeUndefined();
    expect(sidebarTabIds()).toEqual(["a"]);
  });

  it("brings the tab back under the same id, in its place, with its notes", async () => {
    // Same id is the whole trick: mounting the tab asks the backend for that
    // terminal, which reattaches to the still-running shell and replays it.
    seedProject(["a", "b", "c"]);
    useTerminalStore.getState().updateNotes("b", "half-way through the bisect");
    useTerminalStore.getState().patchSession("b", { isNeedsAttention: true, notifyOnInaction: true });
    closeTab("b");

    await expect(reopenLastClosedTab()).resolves.toBe(true);

    const session = useTerminalStore.getState().sessions.b;
    expect(session.notes).toBe("half-way through the bisect");
    expect(session.title).toBe("tab b");
    expect(session.notifyOnInaction).toBe(true);
    // Status described a tab that has been off screen since; it starts over.
    expect(session.isNeedsAttention).toBe(false);
    expect(useLayoutStore.getState().layouts.b).toBeDefined();
    expect(sidebarTabIds()).toEqual(["a", "b", "c"]);
    expect(useTerminalStore.getState().activeTerminalId).toBe("b");
    expect(listClosedTabs()).toEqual([]);
    expect(closeTerminalMock).not.toHaveBeenCalled();
  });

  it("keeps every pane of a split tab", async () => {
    seedProject(["a"]);
    useTerminalStore.getState().addSession("a2", "right", "/tmp");
    useLayoutStore.getState().splitTerminal("a", "a", "a2", "horizontal");

    expect(closeTab("a").sort()).toEqual(["a", "a2"]);
    await expect(reopenLastClosedTab()).resolves.toBe(true);

    expect(useTerminalStore.getState().sessions.a2?.title).toBe("right");
    expect(useLayoutStore.getState().layouts.a?.type).toBe("split");
  });

  it("brings back the project when its last tab took it away", async () => {
    seedProject(["only"]);
    closeTab("only");
    useProjectStore.getState().removeNode("root");
    useProjectStore.getState().removeProject("p1");

    await expect(reopenLastClosedTab()).resolves.toBe(true);

    expect(useProjectStore.getState().projects.p1?.name).toBe("work");
    expect(sidebarTabIds()).toEqual(["only"]);
    expect(useProjectStore.getState().activeProjectId).toBe("p1");
  });

  it("reopens in the order tabs were closed", async () => {
    seedProject(["a", "b"]);
    closeTab("a");
    vi.setSystemTime(Date.now() + 1000);
    closeTab("b");
    vi.useRealTimers();

    await reopenLastClosedTab();
    expect(useTerminalStore.getState().sessions.b).toBeDefined();
    expect(useTerminalStore.getState().sessions.a).toBeUndefined();
    await reopenLastClosedTab();
    expect(useTerminalStore.getState().sessions.a).toBeDefined();
  });

  it("kills the shell once the grace period is over", () => {
    seedProject(["a"]);
    closeTab("a");

    vi.setSystemTime(Date.now() + CLOSED_TAB_TTL_MS + 1);
    reapExpiredClosedLocalTabs();
    vi.useRealTimers();

    expect(closeTerminalMock).toHaveBeenCalledWith("a");
    expect(listClosedTabs()).toEqual([]);
  });

  it("is not mistaken for a hidden tmux window", () => {
    seedProject(["a"]);
    closeTab("a");
    expect(hiddenWindowIdsForConnection(null)).toEqual([]);
  });
});
