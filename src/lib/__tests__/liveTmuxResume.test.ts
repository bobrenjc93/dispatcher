import { describe, expect, it } from "vitest";
import { normalizeRestoredTmuxState } from "../restoredTmuxState";
import type { TerminalSession } from "../../types/terminal";
import type { TreeNode } from "../../types/project";
import { useTerminalStore } from "../../stores/useTerminalStore";

const TRANSPORT = "transport-1";
const WINDOW = "window-1";
const PANE = "pane-1";

function session(id: string, patch: Partial<TerminalSession>): TerminalSession {
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

interface Snapshot {
  liveTerminalIds: ReadonlySet<string>;
  sessions: Record<string, TerminalSession>;
  activeTerminalId: string;
  projects: Record<string, never>;
  nodes: Record<string, TreeNode>;
  activeProjectId: string;
  projectOrder: string[];
  layouts: Record<string, never>;
}

function snapshot(liveTerminalIds: ReadonlySet<string>): Snapshot {
  const sessions: Record<string, TerminalSession> = {
    [TRANSPORT]: session(TRANSPORT, {
      backendKind: "tmux-transport",
      tmuxControlSessionId: TRANSPORT,
    }),
    [WINDOW]: session(WINDOW, {
      backendKind: "tmux-window",
      tmuxControlSessionId: TRANSPORT,
      tmuxWindowId: "@1",
    }),
    [PANE]: session(PANE, {
      backendKind: "tmux-pane",
      tmuxControlSessionId: TRANSPORT,
      tmuxWindowId: "@1",
      tmuxPaneId: "%1",
    }),
  };

  const nodes: Record<string, TreeNode> = {
    root: { id: "root", type: "group", children: ["n-transport", "n-window"] } as never,
    "n-transport": { id: "n-transport", type: "terminal", parentId: "root", terminalId: TRANSPORT } as never,
    "n-window": { id: "n-window", type: "terminal", parentId: "root", terminalId: WINDOW } as never,
  };

  return {
    liveTerminalIds,
    sessions,
    activeTerminalId: WINDOW,
    projects: { p1: { id: "p1", name: "p", rootGroupId: "root", expanded: true } as never },
    nodes,
    activeProjectId: "p1",
    projectOrder: ["p1"],
    layouts: { [WINDOW]: { type: "terminal", id: "l1", terminalId: PANE } as never },
  };
}

describe("tmux state across a reload", () => {
  it("keeps tmux tabs wired up when the transport PTY survived", () => {
    const result = normalizeRestoredTmuxState(snapshot(new Set([TRANSPORT])));

    // The transport tab still exists and the tabs still point at it, so the
    // control session can be resumed rather than re-attached by hand.
    expect(result.sessions[TRANSPORT]).toBeDefined();
    expect(result.sessions[WINDOW].tmuxControlSessionId).toBe(TRANSPORT);
    expect(result.sessions[WINDOW].backendKind).toBe("tmux-window");
    expect(result.sessions[PANE].tmuxControlSessionId).toBe(TRANSPORT);
  });

  it("downgrades them to placeholders when the transport is gone", () => {
    const result = normalizeRestoredTmuxState(snapshot(new Set()));

    // Nothing to reattach to, so the tabs become the restart-safe placeholders.
    expect(result.sessions[TRANSPORT]).toBeUndefined();
    expect(result.sessions[WINDOW]?.tmuxControlSessionId).toBeUndefined();
    expect(result.sessions[WINDOW]?.backendKind).toBe("tmux-window");
  });

  it("keeps tmux tabs when it could not find out what is alive", () => {
    // "Could not ask" is not "nothing is running". Treating them the same
    // deleted transports that were alive, and a deleted transport can never be
    // reattached — it costs an ssh and a `tmux -CC a` per tab, permanently.
    const { liveTerminalIds: _ignored, ...withoutLive } = snapshot(new Set());
    const result = normalizeRestoredTmuxState(withoutLive);

    expect(result.sessions[TRANSPORT]).toBeDefined();
    expect(result.sessions[WINDOW].tmuxControlSessionId).toBe(TRANSPORT);
  });

  it("still drops a transport that is known to be gone", () => {
    // An empty set is an answer: nothing is running, so the tabs really are
    // placeholders now.
    const result = normalizeRestoredTmuxState(snapshot(new Set()));

    expect(result.sessions[TRANSPORT]).toBeUndefined();
  });

  it("survives rehydration with enough state left to reattach", () => {
    // The two halves have to line up: whatever the store's persist merge
    // produces is exactly what normalization gets. Rehydration used to drop
    // every transport and clear each tab's transport link, so by the time this
    // logic ran there was nothing left to resume — the daemon held a live ssh
    // session that the UI could no longer reach. Each half read correctly on
    // its own, which is why this is asserted across the seam.
    const { merge } = (useTerminalStore as unknown as {
      persist: { getOptions: () => { merge: (persisted: unknown, current: unknown) => { sessions: Record<string, TerminalSession>; activeTerminalId: string | null } } };
    }).persist.getOptions();
    const base = snapshot(new Set([TRANSPORT]));
    const rehydrated = merge(
      { sessions: base.sessions, activeTerminalId: base.activeTerminalId },
      { sessions: {}, activeTerminalId: null }
    );

    const result = normalizeRestoredTmuxState({
      ...base,
      sessions: rehydrated.sessions,
      activeTerminalId: rehydrated.activeTerminalId ?? base.activeTerminalId,
    });

    expect(result.sessions[TRANSPORT]?.backendKind).toBe("tmux-transport");
    expect(result.sessions[WINDOW]?.tmuxControlSessionId).toBe(TRANSPORT);
  });

  it("keeps a live transport's tab hidden so it cannot be closed by hand", () => {
    // Closing a transport tab closes the ssh PTY carrying `tmux -CC`, which
    // takes every tmux tab on that host with it. The tab is hidden for that
    // reason, and restoring must not surface it: it reads as a stray "Shell"
    // tab and clicking its close button silently kills the whole connection.
    const base = snapshot(new Set([TRANSPORT]));
    (base.nodes["n-transport"] as { hidden?: boolean }).hidden = true;

    const result = normalizeRestoredTmuxState(base);

    expect(result.sessions[TRANSPORT]).toBeDefined();
    expect((result.nodes["n-transport"] as { hidden?: boolean }).hidden).toBe(true);
    // A hidden non-transport tab is still surfaced; it would be unreachable.
    expect(result.nodes["n-window"]).toBeDefined();
  });

  it("leaves an unrelated live local terminal alone", () => {
    const base = snapshot(new Set([TRANSPORT]));
    base.sessions["local-1"] = session("local-1", { backendKind: "local" });
    // A session needs a tree node, or normalization prunes it as an orphan.
    base.nodes["n-local"] = {
      id: "n-local",
      type: "terminal",
      parentId: "root",
      terminalId: "local-1",
    } as never;
    (base.nodes.root as { children: string[] }).children.push("n-local");

    const result = normalizeRestoredTmuxState(base);

    expect(result.sessions["local-1"].backendKind).toBe("local");
  });
});
