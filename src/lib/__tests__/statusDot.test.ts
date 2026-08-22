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
    })).toBe("#8b6b3f");
  });
});
