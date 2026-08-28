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
});
