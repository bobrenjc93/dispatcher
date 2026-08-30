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
  documentHasFocus: false,
  hasAcknowledgedCurrentOutput: false,
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

  it("stays silent while Dispatcher is the window in front of you", () => {
    // The sound exists to reach someone who is somewhere else. Firing it at a
    // user already watching tells them nothing they cannot see, and is how a
    // notification sound ends up switched off for good.
    expect(shouldNotifyOnInaction({ ...base, documentHasFocus: true })).toBe(false);
  });

  it("says nothing about output the reader has already seen", () => {
    // The case this exists for: a tab stops working while you are watching it,
    // you switch to another app, and twenty seconds later the clock runs out.
    // Nothing changed in between — being told about it is being told about
    // output you had just finished reading.
    expect(
      shouldNotifyOnInaction({ ...base, hasAcknowledgedCurrentOutput: true })
    ).toBe(false);
  });

  it("still fires for output that arrived after the reader looked away", () => {
    expect(
      shouldNotifyOnInaction({ ...base, hasAcknowledgedCurrentOutput: false })
    ).toBe(true);
  });

  it("waits for the inactivity threshold and real activity", () => {
    expect(shouldNotifyOnInaction({ ...base, now: 14_999 })).toBe(false);
    expect(shouldNotifyOnInaction({ ...base, hasDetectedActivity: false })).toBe(false);
    expect(shouldNotifyOnInaction({ ...base, enabled: false })).toBe(false);
  });
});
