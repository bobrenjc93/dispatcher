import { describe, expect, it } from "vitest";
import { carryOverTabSettings } from "../tabSettingsCarryOver";
import type { TerminalSession } from "../../types/terminal";

function tab(patch: Partial<TerminalSession>): TerminalSession {
  return {
    id: "t",
    title: "t",
    notes: "",
    hasDetectedActivity: false,
    lastUserInputAt: 0,
    lastOutputAt: 0,
    isNeedsAttention: false,
    isPossiblyDone: false,
    isLongInactive: false,
    isRecentlyFocused: false,
    backendKind: "tmux-window",
    ...patch,
  };
}

describe("carryOverTabSettings", () => {
  it("moves what was set on the copy going to the copy staying", () => {
    // Removing the older of two copies of a window took its pin, notes and
    // threshold with it; a dozen pinned tabs came back plain.
    const old = tab({
      isPinnedGreen: true,
      notes: "watch the loss curve",
      inactivityThresholdMs: 7_200_000,
      notifyOnInaction: true,
    });
    expect(carryOverTabSettings(old, tab({}))).toEqual({
      isPinnedGreen: true,
      notes: "watch the loss curve",
      inactivityThresholdMs: 7_200_000,
      notifyOnInaction: true,
    });
  });

  it("never overwrites what the kept copy already has", () => {
    const old = tab({ notes: "old", inactivityThresholdMs: 1_000 });
    const kept = tab({ notes: "new", inactivityThresholdMs: 2_000 });
    expect(carryOverTabSettings(old, kept)).toEqual({});
  });

  it("does not leave a tab pinned both green and gray", () => {
    expect(carryOverTabSettings(tab({ isPinnedGreen: true }), tab({ isPinnedGray: true }))).toEqual({});
  });
});
