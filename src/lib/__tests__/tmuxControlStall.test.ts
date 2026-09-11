import { describe, expect, it } from "vitest";
import {
  TMUX_CONTROL_STALL_MS,
  hasControlStreamStalled,
  isShellRejectingControlCommand,
} from "../tmuxControlStall";

describe("isShellRejectingControlCommand", () => {
  it("recognises a shell answering one of our own commands", () => {
    // Taken from the log of a tab that sat frozen for thirty-four minutes.
    expect(isShellRejectingControlCommand("zsh: command not found: refresh-client")).toBe(true);
    expect(isShellRejectingControlCommand("bash: capture-pane: command not found")).toBe(true);
    expect(isShellRejectingControlCommand("sh: 1: list-windows: not found")).toBe(true);
  });

  it("ignores output that merely mentions something missing", () => {
    // Two earlier versions of this detector keyed on "not a control-mode
    // line", which ordinary TUI output satisfies, and tore down live
    // sessions. Naming one of our commands is the part that cannot happen by
    // accident.
    expect(isShellRejectingControlCommand("Error: command not found: git")).toBe(false);
    expect(isShellRejectingControlCommand("FileNotFoundError: config.yaml not found")).toBe(false);
    expect(isShellRejectingControlCommand("running capture-pane in the test suite")).toBe(false);
    expect(isShellRejectingControlCommand("")).toBe(false);
  });
});

describe("hasControlStreamStalled", () => {
  const now = 1_000_000;

  it("says nothing while there is nothing outstanding", () => {
    expect(
      hasControlStreamStalled({ pendingCommandCount: 0, oldestPendingSentAt: now - 600_000, now })
    ).toBe(false);
    expect(
      hasControlStreamStalled({ pendingCommandCount: 3, oldestPendingSentAt: null, now })
    ).toBe(false);
  });

  it("waits far longer than any round trip before deciding", () => {
    // A loaded host pauses; an ssh hop does not take a minute.
    expect(
      hasControlStreamStalled({
        pendingCommandCount: 1,
        oldestPendingSentAt: now - (TMUX_CONTROL_STALL_MS - 1),
        now,
      })
    ).toBe(false);
    expect(
      hasControlStreamStalled({
        pendingCommandCount: 1,
        oldestPendingSentAt: now - TMUX_CONTROL_STALL_MS,
        now,
      })
    ).toBe(true);
  });
});
