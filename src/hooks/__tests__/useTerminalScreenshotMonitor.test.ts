import { describe, expect, it } from "vitest";
import {
  selectVisualSampleTabRootTerminalIds,
  shouldIgnoreTmuxFocusVisualChange,
} from "../useTerminalScreenshotMonitor";

describe("shouldIgnoreTmuxFocusVisualChange", () => {
  it("ignores tmux redraws that only reflect focus churn", () => {
    expect(shouldIgnoreTmuxFocusVisualChange({
      changed: true,
      hasActiveFocusVisualSuppression: true,
      hasTmuxStatusSession: true,
      lastUserInputAt: 1_000,
      lastOutputAt: 1_000,
      suppressionStartedAt: 2_000,
    })).toBe(true);
  });

  it("does not ignore visual changes when terminal output arrived after focus", () => {
    expect(shouldIgnoreTmuxFocusVisualChange({
      changed: true,
      hasActiveFocusVisualSuppression: true,
      hasTmuxStatusSession: true,
      lastUserInputAt: 1_000,
      lastOutputAt: 2_001,
      suppressionStartedAt: 2_000,
    })).toBe(false);
  });
});

describe("selectVisualSampleTabRootTerminalIds", () => {
  it("prioritizes the active tab and rotates through ready background tabs", () => {
    const first = selectVisualSampleTabRootTerminalIds({
      tabRootTerminalIds: ["a", "b", "c", "d"],
      activeTabRootTerminalId: "c",
      maxTabs: 3,
      cursor: 0,
      canSample: (id) => id !== "b",
    });

    expect(first.selected).toEqual(["c", "a", "d"]);
    expect(first.nextCursor).toBe(0);

    const second = selectVisualSampleTabRootTerminalIds({
      tabRootTerminalIds: ["a", "b", "c", "d", "e"],
      activeTabRootTerminalId: "c",
      maxTabs: 3,
      cursor: 1,
      canSample: (id) => id !== "b",
    });

    expect(second.selected).toEqual(["c", "d", "e"]);
    expect(second.nextCursor).toBe(0);
  });

  it("returns no tabs when no terminal frontends are ready", () => {
    expect(selectVisualSampleTabRootTerminalIds({
      tabRootTerminalIds: ["a", "b"],
      activeTabRootTerminalId: "a",
      maxTabs: 3,
      cursor: 0,
      canSample: () => false,
    })).toEqual({ selected: [], nextCursor: 0 });
  });
});
