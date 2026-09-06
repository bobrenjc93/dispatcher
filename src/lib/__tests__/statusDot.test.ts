import { describe, expect, it } from "vitest";
import { resolveStatusDotColor } from "../../components/common/StatusDot";

describe("resolveStatusDotColor", () => {
  it("keeps a pinned terminal green regardless of runtime status", () => {
    expect(resolveStatusDotColor({
      hasDetectedActivity: false,
      isNeedsAttention: false,
      isPossiblyDone: true,
      isLongInactive: true,
      isPinnedGreen: true,
      isPinnedGray: false,
      isSnoozed: false,
    })).toBe("#00c853");
  });

  it("keeps a gray-pinned terminal gray regardless of runtime status", () => {
    expect(resolveStatusDotColor({
      hasDetectedActivity: true,
      isNeedsAttention: true,
      isPossiblyDone: false,
      isLongInactive: false,
      isPinnedGreen: false,
      isPinnedGray: true,
      isSnoozed: false,
    })).toBe("#7b8794");
  });

  it("preserves the existing unpinned status colors", () => {
    expect(resolveStatusDotColor({
      hasDetectedActivity: true,
      isNeedsAttention: false,
      isPossiblyDone: true,
      isLongInactive: false,
      isPinnedGreen: false,
      isPinnedGray: false,
      isSnoozed: false,
    })).toBe("#8b6b3f");
  });
});

describe("snoozed terminals", () => {
  const base = {
    hasDetectedActivity: true,
    isNeedsAttention: false,
    isPossiblyDone: true,
    isLongInactive: true,
    isPinnedGreen: false,
    isPinnedGray: false,
    isSnoozed: true,
  };

  it("reads as working while snoozed, whatever the monitor derived", () => {
    // The point of a snooze is that the user has already decided the tab is
    // fine for now, so brown and gray are both wrong until it lapses.
    expect(resolveStatusDotColor(base)).toBe("#00c853");
  });

  it("still lets an explicit gray pin win", () => {
    // Pinning gray is a deliberate "I do not care about this tab at all",
    // which outranks a temporary "not yet".
    expect(resolveStatusDotColor({ ...base, isPinnedGray: true })).toBe("#7b8794");
  });

  it("goes back to telling the truth once it lapses", () => {
    expect(resolveStatusDotColor({ ...base, isSnoozed: false })).toBe("#7b8794");
  });
});
