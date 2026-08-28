import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  disposeAttachWatchdog,
  isAttachPending,
  noteControlModeStarted,
  noteTerminalInput,
  noteTerminalOutput,
  setAttachStalledHandler,
} from "../tmuxAttachWatchdog";

const TERMINAL = "t1";

describe("silent tmux attach detection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    disposeAttachWatchdog(TERMINAL);
  });

  afterEach(() => {
    setAttachStalledHandler(null);
    disposeAttachWatchdog(TERMINAL);
    vi.useRealTimers();
  });

  const type = (text: string) => {
    for (const char of text) {
      noteTerminalInput(TERMINAL, char);
    }
  };

  it("starts watching when a control-mode command is submitted", () => {
    type("tmux -CC a\r");
    expect(isAttachPending(TERMINAL)).toBe(true);
  });

  it("ignores ordinary commands", () => {
    type("ls -la\r");
    type("tmux ls\r");
    type("echo tmux -CC\r");
    expect(isAttachPending(TERMINAL)).toBe(false);
  });

  it("recognises the command mid-line and after a separator", () => {
    type("cd /tmp && tmux -CC new-session -A -s work\r");
    expect(isAttachPending(TERMINAL)).toBe(true);
  });

  it("reports a stall when nothing but the echo comes back", () => {
    const stalled = vi.fn();
    setAttachStalledHandler(stalled);

    type("tmux -CC a\r");
    // The shell echoes the newline; that is not evidence of life.
    noteTerminalOutput(TERMINAL, "[?2004l\r\r\n".length);
    vi.advanceTimersByTime(5_000);

    expect(stalled).toHaveBeenCalledWith(TERMINAL, "tmux -CC a");
  });

  it("stays quiet when the attach succeeds", () => {
    const stalled = vi.fn();
    setAttachStalledHandler(stalled);

    type("tmux -CC a\r");
    noteControlModeStarted(TERMINAL);
    vi.advanceTimersByTime(5_000);

    expect(stalled).not.toHaveBeenCalled();
    expect(isAttachPending(TERMINAL)).toBe(false);
  });

  it("stays quiet when tmux fails normally with a message", () => {
    const stalled = vi.fn();
    setAttachStalledHandler(stalled);

    type("tmux -CC a\r");
    noteTerminalOutput(TERMINAL, "no sessions\r\n".length);
    noteTerminalOutput(TERMINAL, "bobren@host ~ % ".repeat(4).length);
    vi.advanceTimersByTime(5_000);

    expect(stalled).not.toHaveBeenCalled();
  });

  it("handles backspaces while the line is being edited", () => {
    type("tmux -CCx");
    noteTerminalInput(TERMINAL, "");
    type(" a\r");
    expect(isAttachPending(TERMINAL)).toBe(true);
  });
});
