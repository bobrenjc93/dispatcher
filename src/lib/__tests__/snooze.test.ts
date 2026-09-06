import { describe, expect, it } from "vitest";
import {
  DEFAULT_SNOOZE_MS,
  formatSnoozeRemaining,
  isSnoozeActive,
  parseSnoozeMinutes,
} from "../snooze";

describe("isSnoozeActive", () => {
  it("runs until the deadline and not past it", () => {
    expect(isSnoozeActive(1_000, 999)).toBe(true);
    expect(isSnoozeActive(1_000, 1_000)).toBe(false);
    expect(isSnoozeActive(1_000, 1_001)).toBe(false);
  });

  it("treats an unusable value as not snoozed", () => {
    // This arrives from replicated workspace state. A tab stuck permanently
    // green because of a corrupt number is the outcome worth ruling out.
    expect(isSnoozeActive(undefined, 5)).toBe(false);
    expect(isSnoozeActive(Number.NaN, 5)).toBe(false);
    // Infinity is the stuck-green-forever case by another name, and a snooze
    // that never ends is a pin — which already exists and is explicit.
    expect(isSnoozeActive(Number.POSITIVE_INFINITY, 5)).toBe(false);
  });
});

describe("parseSnoozeMinutes", () => {
  it("turns minutes into a deadline", () => {
    expect(parseSnoozeMinutes("5", 1_000)).toEqual({ ok: true, until: 1_000 + DEFAULT_SNOOZE_MS });
    expect(parseSnoozeMinutes(" 90 ", 0)).toEqual({ ok: true, until: 90 * 60_000 });
  });

  it("accepts a fraction of a minute", () => {
    expect(parseSnoozeMinutes("0.5", 0)).toEqual({ ok: true, until: 30_000 });
  });

  it("rejects rather than snoozing for a length nobody asked for", () => {
    expect(parseSnoozeMinutes("", 0).ok).toBe(false);
    expect(parseSnoozeMinutes("soon", 0).ok).toBe(false);
    expect(parseSnoozeMinutes("0", 0).ok).toBe(false);
    expect(parseSnoozeMinutes("-5", 0).ok).toBe(false);
  });
});

describe("formatSnoozeRemaining", () => {
  it("rounds up so a running snooze never reads as finished", () => {
    expect(formatSnoozeRemaining(1_000, 999)).toBe("1m");
    expect(formatSnoozeRemaining(60_000, 0)).toBe("1m");
    expect(formatSnoozeRemaining(61_000, 0)).toBe("2m");
  });

  it("uses hours once there are enough minutes to bother", () => {
    expect(formatSnoozeRemaining(60 * 60_000, 0)).toBe("1h");
    expect(formatSnoozeRemaining(90 * 60_000, 0)).toBe("1h 30m");
  });

  it("does not go negative once the deadline has passed", () => {
    expect(formatSnoozeRemaining(1_000, 99_999)).toBe("0m");
  });
});
