import { describe, expect, it, beforeEach } from "vitest";
import { buildAppStateSnapshot, getAppStateSignature } from "../appStateSnapshot";
import { applyDocumentPatch, buildDocumentPatch } from "../documentPatch";
import { useLayoutStore } from "../../stores/useLayoutStore";
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

function seed() {
  useProjectStore.setState({
    projects: {
      p1: { id: "p1", name: "proj", rootGroupId: "r1", expanded: false } as never,
    },
    nodes: { r1: { id: "r1", type: "group", children: [] } as never },
    activeProjectId: "p1",
    projectOrder: ["p1"],
  });
  useTerminalStore.setState({ sessions: { t1: session("t1") }, activeTerminalId: "t1" });
  useLayoutStore.setState({ layouts: {} });
}

describe("document patches from a replica", () => {
  beforeEach(seed);

  it("carries only the field the user changed", () => {
    const base = buildAppStateSnapshot();
    useProjectStore.setState((s) => ({
      projects: { ...s.projects, p1: { ...s.projects.p1, expanded: true } },
    }));

    const patch = buildDocumentPatch(base, buildAppStateSnapshot());

    expect(patch).toEqual({ projects: { p1: { expanded: true } } });
  });

  it("reports no patch when nothing changed", () => {
    const base = buildAppStateSnapshot();
    expect(buildDocumentPatch(base, buildAppStateSnapshot())).toBeNull();
  });

  it("does not clobber fields the desktop changed meanwhile", () => {
    // The replica expands a project, based on a document from a moment ago.
    const base = buildAppStateSnapshot();
    useProjectStore.setState((s) => ({
      projects: { ...s.projects, p1: { ...s.projects.p1, expanded: true } },
    }));
    const patch = buildDocumentPatch(base, buildAppStateSnapshot())!;

    // Meanwhile the desktop renamed the project and a status dot moved on.
    useProjectStore.setState((s) => ({
      projects: { ...s.projects, p1: { ...s.projects.p1, expanded: false, name: "renamed" } },
    }));
    useTerminalStore.setState((s) => ({
      sessions: { ...s.sessions, t1: { ...s.sessions.t1, isPossiblyDone: true } },
    }));

    applyDocumentPatch(patch);

    // The replica's edit lands, and the desktop's concurrent edits survive.
    expect(useProjectStore.getState().projects.p1.expanded).toBe(true);
    expect(useProjectStore.getState().projects.p1.name).toBe("renamed");
    expect(useTerminalStore.getState().sessions.t1.isPossiblyDone).toBe(true);
  });

  it("syncs notes without touching status fields", () => {
    const base = buildAppStateSnapshot();
    useTerminalStore.setState((s) => ({
      sessions: { ...s.sessions, t1: { ...s.sessions.t1, notes: "written in the browser" } },
    }));
    const patch = buildDocumentPatch(base, buildAppStateSnapshot())!;

    expect(patch).toEqual({ sessions: { t1: { notes: "written in the browser" } } });

    useTerminalStore.setState((s) => ({
      sessions: { ...s.sessions, t1: { ...s.sessions.t1, notes: "", isNeedsAttention: true } },
    }));
    applyDocumentPatch(patch);

    expect(useTerminalStore.getState().sessions.t1.notes).toBe("written in the browser");
    expect(useTerminalStore.getState().sessions.t1.isNeedsAttention).toBe(true);
  });

  it("carries additions and removals", () => {
    const base = buildAppStateSnapshot();
    useTerminalStore.setState({
      sessions: { t2: session("t2") },
      activeTerminalId: "t2",
    });

    const patch = buildDocumentPatch(base, buildAppStateSnapshot())!;
    expect(patch.sessions?.t2).toBeDefined();
    expect(patch.removed?.sessions).toEqual(["t1"]);
    expect(patch.activeTerminalId).toBe("t2");

    seed();
    applyDocumentPatch(patch);
    expect(Object.keys(useTerminalStore.getState().sessions)).toEqual(["t2"]);
    expect(useTerminalStore.getState().activeTerminalId).toBe("t2");
  });

  it("replaces a changed layout tree wholesale", () => {
    const base = buildAppStateSnapshot();
    useLayoutStore.setState({
      layouts: { t1: { type: "terminal", id: "n1", terminalId: "t1" } },
    });

    const patch = buildDocumentPatch(base, buildAppStateSnapshot())!;
    expect(patch.layouts?.t1).toEqual({ type: "terminal", id: "n1", terminalId: "t1" });

    seed();
    applyDocumentPatch(patch);
    expect(useLayoutStore.getState().layouts.t1).toBeDefined();
  });

  it("ignores an empty patch", () => {
    const before = getAppStateSignature(buildAppStateSnapshot());

    applyDocumentPatch({});

    expect(getAppStateSignature(buildAppStateSnapshot())).toBe(before);
  });
});
