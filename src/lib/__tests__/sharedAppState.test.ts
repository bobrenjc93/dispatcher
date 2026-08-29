import { describe, expect, it, vi } from "vitest";

const { isPrimaryClientMock } = vi.hoisted(() => ({ isPrimaryClientMock: vi.fn(() => true) }));
vi.mock("../replication", () => ({ isPrimaryClient: isPrimaryClientMock }));
import {
  APP_STATE_LAYOUTS_KEY,
  APP_STATE_PROJECTS_KEY,
  APP_STATE_TERMINALS_KEY,
} from "../storageNamespace";
import {
  type AppStateSnapshot,
  applySharedAppState,
  buildAppStateSnapshot,
  getAppStateSignature,
} from "../appStateSnapshot";
import { useProjectStore } from "../../stores/useProjectStore";
import { useTerminalStore } from "../../stores/useTerminalStore";
import type { TerminalSession } from "../../types/terminal";

function session(id: string, patch: Partial<TerminalSession> = {}): TerminalSession {
  return {
    id,
    title: id,
    notes: "",
    hasDetectedActivity: false,
    lastUserInputAt: 0,
    lastOutputAt: 0,
    isNeedsAttention: false,
    isPossiblyDone: false,
    isLongInactive: false,
    isRecentlyFocused: false,
    isPinnedGreen: false,
    isPinnedGray: false,
    notifyOnInaction: false,
    backendKind: "local",
    ...patch,
  };
}

function snapshotWith(sessions: Record<string, TerminalSession>): AppStateSnapshot {
  return {
    source: "test",
    exportedAt: "2026-01-01T00:00:00.000Z",
    [APP_STATE_PROJECTS_KEY]: {
      state: {
        projects: { p1: { id: "p1", name: "Project" } as never },
        nodes: {},
        activeProjectId: "p1",
        projectOrder: ["p1"],
      },
      version: 0,
    },
    [APP_STATE_TERMINALS_KEY]: {
      state: { sessions, activeTerminalId: Object.keys(sessions)[0] ?? null },
      version: 0,
    },
    [APP_STATE_LAYOUTS_KEY]: {
      state: { layouts: {} },
      version: 0,
    },
  };
}

describe("shared app state", () => {
  it("ignores bookkeeping fields when comparing snapshots", () => {
    const base = snapshotWith({ t1: session("t1") });
    const sameContentLaterTimestamp: AppStateSnapshot = {
      ...base,
      exportedAt: "2026-06-01T12:00:00.000Z",
      source: "another-client",
    };

    expect(getAppStateSignature(sameContentLaterTimestamp)).toBe(getAppStateSignature(base));
  });

  it("distinguishes snapshots whose contents differ", () => {
    const one = snapshotWith({ t1: session("t1") });
    const two = snapshotWith({ t1: session("t1"), t2: session("t2") });

    expect(getAppStateSignature(two)).not.toBe(getAppStateSignature(one));
  });

  it("adopting a peer's state is idempotent, so updates cannot echo forever", () => {
    const incoming = snapshotWith({ t1: session("t1"), t2: session("t2") });

    expect(applySharedAppState(incoming, "test").restored).toBe(true);

    // Rebuilding from the stores must reproduce the same signature, otherwise
    // adopting a peer's state would immediately look like a local change and
    // get published straight back to them.
    expect(getAppStateSignature(buildAppStateSnapshot())).toBe(getAppStateSignature(incoming));
  });

  it("keeps live tmux tabs intact instead of downgrading them to placeholders", () => {
    const incoming = snapshotWith({
      transport: session("transport", {
        backendKind: "tmux-transport",
        tmuxControlSessionId: "transport",
      }),
      pane: session("pane", {
        backendKind: "tmux-pane",
        tmuxControlSessionId: "transport",
        tmuxWindowId: "@1",
        tmuxPaneId: "%1",
      }),
    });

    applySharedAppState(incoming, "test");

    const sessions = useTerminalStore.getState().sessions;
    expect(sessions.pane.backendKind).toBe("tmux-pane");
    expect(sessions.pane.tmuxControlSessionId).toBe("transport");
    expect(sessions.transport).toBeDefined();
  });

  it("applies projects and the active selection from the peer", () => {
    applySharedAppState(snapshotWith({ t1: session("t1") }), "test");

    expect(useProjectStore.getState().activeProjectId).toBe("p1");
    expect(useTerminalStore.getState().activeTerminalId).toBe("t1");
  });

  it("rejects a malformed snapshot rather than clearing local state", () => {
    applySharedAppState(snapshotWith({ t1: session("t1") }), "test");

    const result = applySharedAppState({ source: "broken" } as AppStateSnapshot, "test");

    expect(result.restored).toBe(false);
    expect(Object.keys(useTerminalStore.getState().sessions)).toEqual(["t1"]);
  });
});

describe("who owns the active tab", () => {
  function snapshotWithActive(activeTerminalId: string | null): AppStateSnapshot {
    useProjectStore.setState({
      projects: { p: { id: "p", name: "p", rootGroupId: "root", expanded: true } as never },
      projectOrder: ["p"],
      activeProjectId: "p",
      nodes: {
        root: { id: "root", type: "group", parentId: null, children: ["n1", "n2"] } as never,
        n1: { id: "n1", type: "terminal", parentId: "root", terminalId: "t1" } as never,
        n2: { id: "n2", type: "terminal", parentId: "root", terminalId: "t2" } as never,
      },
    });
    useTerminalStore.setState({
      sessions: { t1: session("t1"), t2: session("t2") },
      activeTerminalId,
    });
    return buildAppStateSnapshot();
  }

  it("keeps the desktop's active tab when a replica's snapshot arrives", () => {
    // The desktop publishes the shared document. A snapshot already in flight
    // when the user clicked used to land afterwards and revert the click.
    isPrimaryClientMock.mockReturnValue(true);
    const stale = snapshotWithActive("t1");
    useTerminalStore.setState({ activeTerminalId: "t2" });

    applySharedAppState(stale, "test");

    expect(useTerminalStore.getState().activeTerminalId).toBe("t2");
  });

  it("adopts the master's active tab in a replica", () => {
    isPrimaryClientMock.mockReturnValue(false);
    const fromMaster = snapshotWithActive("t1");
    useTerminalStore.setState({ activeTerminalId: "t2" });

    applySharedAppState(fromMaster, "test");

    expect(useTerminalStore.getState().activeTerminalId).toBe("t1");
  });

  it("adopts one when the desktop has none yet, as on a cold start", () => {
    isPrimaryClientMock.mockReturnValue(true);
    const fromElsewhere = snapshotWithActive("t1");
    useTerminalStore.setState({ activeTerminalId: null });

    applySharedAppState(fromElsewhere, "test");

    expect(useTerminalStore.getState().activeTerminalId).toBe("t1");
  });
});
