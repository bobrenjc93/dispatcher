import { describe, expect, it } from "vitest";
import { shouldNotifyOnInaction } from "../inactionNotification";

const base = {
  enabled: true,
  wasEnabled: true,
  hasDetectedActivity: true,
  now: 20_000,
  staleStartedAt: 15_000,
  effectiveChangedAt: 5_000,
  lastNotifiedChangedAt: 0,
};

describe("shouldNotifyOnInaction", () => {
  it("fires after an armed activity generation becomes stale", () => {
    expect(shouldNotifyOnInaction(base)).toBe(true);
  });

  it("does not fire immediately when the option is enabled", () => {
    expect(shouldNotifyOnInaction({ ...base, wasEnabled: false })).toBe(false);
  });

  it("fires only once for the same activity generation", () => {
    expect(shouldNotifyOnInaction({
      ...base,
      lastNotifiedChangedAt: base.effectiveChangedAt,
    })).toBe(false);
  });

  it("waits for the inactivity threshold and real activity", () => {
    expect(shouldNotifyOnInaction({ ...base, now: 14_999 })).toBe(false);
    expect(shouldNotifyOnInaction({ ...base, hasDetectedActivity: false })).toBe(false);
    expect(shouldNotifyOnInaction({ ...base, enabled: false })).toBe(false);
  });
});
