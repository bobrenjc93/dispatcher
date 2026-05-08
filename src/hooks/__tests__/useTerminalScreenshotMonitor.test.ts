import { describe, expect, it } from "vitest";
import { shouldIgnoreTmuxFocusVisualChange } from "../useTerminalScreenshotMonitor";

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
