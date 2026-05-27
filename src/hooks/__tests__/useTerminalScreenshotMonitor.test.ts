import { describe, expect, it } from "vitest";
import {
  resolveTimestampStatusChangedAt,
  selectVisualSampleTabRootTerminalIds,
  shouldIgnoreTmuxFocusVisualChange,
  shouldUseTimestampOnlyStatus,
  shouldWriteScreenshotDebugArtifact,
} from "../useTerminalScreenshotMonitor";
import { shouldIgnoreStatusResizeChange } from "../../lib/statusResizeSuppression";
import type { TerminalSession } from "../../types/terminal";

function session(patch: Partial<TerminalSession> = {}): TerminalSession {
  return {
    id: "s",
    title: "Shell",
    notes: "",
    cwd: undefined,
    hasDetectedActivity: false,
    lastUserInputAt: 0,
    lastOutputAt: 0,
    isNeedsAttention: false,
    isPossiblyDone: false,
    isLongInactive: false,
    isRecentlyFocused: false,
    backendKind: "local",
    ...patch,
  };
}

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

describe("shouldIgnoreStatusResizeChange", () => {
  it("ignores visual changes that only reflect recent resize", () => {
    expect(shouldIgnoreStatusResizeChange({
      changed: true,
      suppression: {
        terminalId: "pane",
        startedAt: 2_000,
        until: 7_000,
        reason: "test-resize",
      },
      lastUserInputAt: 1_000,
      lastOutputAt: 1_000,
    })).toBe(true);
  });

  it("does not ignore visual changes after output arrives post-resize", () => {
    expect(shouldIgnoreStatusResizeChange({
      changed: true,
      suppression: {
        terminalId: "pane",
        startedAt: 2_000,
        until: 7_000,
        reason: "test-resize",
      },
      lastUserInputAt: 1_000,
      lastOutputAt: 2_001,
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

describe("shouldUseTimestampOnlyStatus", () => {
  it("uses timestamp-only status for tmux tabs", () => {
    expect(shouldUseTimestampOnlyStatus([
      session({ backendKind: "tmux-pane" }),
    ])).toBe(true);
    expect(shouldUseTimestampOnlyStatus([
      session({ backendKind: "tmux-window" }),
    ])).toBe(true);
    expect(shouldUseTimestampOnlyStatus([
      session({ backendKind: "local" }),
    ])).toBe(false);
  });
});

describe("resolveTimestampStatusChangedAt", () => {
  it("uses tmux output time rather than a newer visual sample baseline", () => {
    expect(resolveTimestampStatusChangedAt({
      timestampOnlyStatus: true,
      latestActivityAt: 10_000,
      previousChangedAt: 20_000,
      now: 21_000,
    })).toEqual({
      changed: false,
      changedAt: 10_000,
    });
  });

  it("keeps the previous visual baseline for non-tmux timestamp fallback", () => {
    expect(resolveTimestampStatusChangedAt({
      timestampOnlyStatus: false,
      latestActivityAt: 10_000,
      previousChangedAt: 20_000,
      now: 21_000,
    })).toEqual({
      changed: false,
      changedAt: 20_000,
    });
  });
});

describe("shouldWriteScreenshotDebugArtifact", () => {
  it("requires a real status transition after baseline capture", () => {
    expect(shouldWriteScreenshotDebugArtifact({
      isBaselineCapture: true,
      statusTransitioned: true,
      now: 10_000,
      lastTabArtifactAt: 0,
      lastGlobalArtifactAt: 0,
      perTabIntervalMs: 1_000,
      globalIntervalMs: 1_000,
    })).toBe(false);

    expect(shouldWriteScreenshotDebugArtifact({
      isBaselineCapture: false,
      statusTransitioned: false,
      now: 10_000,
      lastTabArtifactAt: 0,
      lastGlobalArtifactAt: 0,
      perTabIntervalMs: 1_000,
      globalIntervalMs: 1_000,
    })).toBe(false);
  });

  it("rate limits screenshot artifacts per tab and globally", () => {
    const base = {
      isBaselineCapture: false,
      statusTransitioned: true,
      now: 10_000,
      perTabIntervalMs: 5_000,
      globalIntervalMs: 2_000,
    };

    expect(shouldWriteScreenshotDebugArtifact({
      ...base,
      lastTabArtifactAt: 4_000,
      lastGlobalArtifactAt: 0,
    })).toBe(true);

    expect(shouldWriteScreenshotDebugArtifact({
      ...base,
      lastTabArtifactAt: 6_000,
      lastGlobalArtifactAt: 0,
    })).toBe(false);

    expect(shouldWriteScreenshotDebugArtifact({
      ...base,
      lastTabArtifactAt: 0,
      lastGlobalArtifactAt: 9_000,
    })).toBe(false);
  });
});
