import { describe, expect, it, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useTerminalStore } from "../../stores/useTerminalStore";
import type { TerminalSession } from "../../types/terminal";

// Role is derived from the runtime, so the tests drive it directly.
const isWebClient = vi.fn(() => false);
vi.mock("../webBridge", () => ({ isWebClient: () => isWebClient() }));

const {
  isPrimaryClient,
  isReplicaClient,
  mirrorTerminalOutput,
  performAction,
  registerActionHandler,
  setReplicaCount,
  trimSnapshotBuffer,
  orderSnapshotTerminalIds,
} = await import("../replication");
const { handleTmuxTerminalFocus, renameTmuxTerminal } = await import("../tmuxControl");

const invokeMock = vi.mocked(invoke);

function relayCalls() {
  return invokeMock.mock.calls.filter(([cmd]) => cmd === "relay_action");
}

function seedTmuxWindow() {
  const base: Omit<TerminalSession, "id" | "title" | "backendKind"> = {
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
  };

  useTerminalStore.setState({
    sessions: {
      window: {
        ...base,
        id: "window",
        title: "window",
        backendKind: "tmux-window",
        tmuxControlSessionId: "transport",
        tmuxWindowId: "@1",
      },
    },
    activeTerminalId: "window",
  });
}

describe("desktop-as-master replication", () => {
  beforeEach(() => {
    isWebClient.mockReturnValue(false);
    invokeMock.mockClear();
    setReplicaCount(0);
    seedTmuxWindow();
  });

  it("reports the desktop window as the master and a browser as a replica", () => {
    expect(isPrimaryClient()).toBe(true);
    expect(isReplicaClient()).toBe(false);

    isWebClient.mockReturnValue(true);
    expect(isPrimaryClient()).toBe(false);
    expect(isReplicaClient()).toBe(true);
  });

  it("performs an action in place on the desktop window", () => {
    const handler = vi.fn();
    registerActionHandler("closePane", handler);

    performAction("closePane", "terminal-1");

    expect(handler).toHaveBeenCalledWith("terminal-1");
    expect(relayCalls()).toHaveLength(0);
  });

  it("relays an action from a replica instead of performing it there", () => {
    const handler = vi.fn();
    registerActionHandler("closePane", handler);
    isWebClient.mockReturnValue(true);

    performAction("closePane", "terminal-1");

    expect(handler).not.toHaveBeenCalled();
    expect(relayCalls()).toHaveLength(1);
    expect(relayCalls()[0][1]).toMatchObject({
      action: { name: "closePane", args: ["terminal-1"] },
    });
  });

  it("sends replica keystrokes to the desktop rather than to a PTY", () => {
    isWebClient.mockReturnValue(true);

    performAction("terminalInput", "terminal-1", "ls\r");

    expect(relayCalls()[0][1]).toMatchObject({
      action: { name: "terminalInput", args: ["terminal-1", "ls\r"] },
    });
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === "write_terminal")).toBe(false);
  });

  it("relays tmux focus from a replica instead of driving the control stream", () => {
    isWebClient.mockReturnValue(true);

    handleTmuxTerminalFocus("window");

    expect(relayCalls()).toHaveLength(1);
    expect(relayCalls()[0][1]).toMatchObject({
      action: { name: "focusTerminal", args: ["window"] },
    });
  });

  it("relays tmux rename from a replica and leaves the control stream alone", async () => {
    isWebClient.mockReturnValue(true);

    await renameTmuxTerminal("window", "renamed");

    expect(relayCalls()[0][1]).toMatchObject({
      action: { name: "renameTerminal", args: ["window", "renamed"] },
    });
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === "write_terminal")).toBe(false);
  });

  it("only mirrors terminal output while a replica is watching", () => {
    mirrorTerminalOutput("terminal-1", "hello");
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === "publish_mirror")).toBe(false);

    setReplicaCount(1);
    mirrorTerminalOutput("terminal-1", "hello");
    // Frames are coalesced, so the publish lands on the next flush.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(invokeMock.mock.calls.some(([cmd]) => cmd === "publish_mirror")).toBe(true);
        resolve();
      }, 40);
    });
  });

  it("never mirrors from a replica, so output cannot loop back", async () => {
    isWebClient.mockReturnValue(true);
    setReplicaCount(1);

    mirrorTerminalOutput("terminal-1", "hello");

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === "publish_mirror")).toBe(false);
  });

  it("trims a replica snapshot at a line boundary, not mid-escape-sequence", () => {
    // A replica's scrollback starts wherever this cut lands. Slicing at an
    // arbitrary byte can land inside an escape sequence, and xterm then renders
    // the tail of it as literal text across the top of the history.
    const keep = "\u001b[32mkept line\u001b[0m\n";
    const buffer = `old\n\u001b[31mdropped\u001b[0m\n${keep}`;

    const trimmed = trimSnapshotBuffer(buffer, keep.length + 2);

    expect(trimmed).toBe(keep);
    expect(trimmed.startsWith("\u001b[")).toBe(true);
  });

  it("keeps a snapshot that still fits untouched", () => {
    const buffer = "line one\nline two\n";
    expect(trimSnapshotBuffer(buffer, 1024)).toBe(buffer);
  });

  it("falls back to a hard cut when the tail holds no line break", () => {
    // A single enormous line still has to be bounded, or the budget means
    // nothing for a pane that never emits a newline.
    const buffer = "x".repeat(100);
    expect(trimSnapshotBuffer(buffer, 10)).toHaveLength(10);
  });

  it("sends the tab the replica is about to show before the rest", () => {
    // A workspace of twenty terminals is tens of megabytes of scrollback. In
    // map order the one terminal actually on screen can be last, so the reader
    // watches a spinner while tabs they cannot see arrive ahead of it.
    expect(orderSnapshotTerminalIds(["a", "b", "c"], "c")).toEqual(["c", "a", "b"]);
  });

  it("leaves the order alone when the active tab is not among them", () => {
    expect(orderSnapshotTerminalIds(["a", "b"], "gone")).toEqual(["a", "b"]);
    expect(orderSnapshotTerminalIds(["a", "b"], null)).toEqual(["a", "b"]);
  });

  it("keeps every terminal, just reordered", () => {
    const ids = ["a", "b", "c", "d"];
    expect(orderSnapshotTerminalIds(ids, "b").sort()).toEqual(ids);
  });
});
