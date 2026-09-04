import { describe, expect, it } from "vitest";
import {
  DEFAULT_INACTIVITY_THRESHOLD_MS,
  formatInactivityThreshold,
  parseInactivityThresholdSeconds,
  resolveInactivityThresholdMs,
} from "../inactivityThreshold";

describe("resolveInactivityThresholdMs", () => {
  it("falls back to the default when a tab has no override", () => {
    expect(resolveInactivityThresholdMs(undefined)).toBe(DEFAULT_INACTIVITY_THRESHOLD_MS);
  });

  it("accepts whatever the user asked for, with no ceiling", () => {
    expect(resolveInactivityThresholdMs(45_000)).toBe(45_000);
    // A day, for a tab watching something that reports once a day.
    expect(resolveInactivityThresholdMs(86_500_000)).toBe(86_500_000);
    // And a very short one, if that is genuinely wanted.
    expect(resolveInactivityThresholdMs(1_000)).toBe(1_000);
  });

  it("falls back only for values that are not a duration", () => {
    // Reachable from replicated workspace state, not just the dialog, so a tab
    // whose status silently never updates again is the risk being avoided.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0]) {
      expect(resolveInactivityThresholdMs(bad)).toBe(DEFAULT_INACTIVITY_THRESHOLD_MS);
    }
  });
});

describe("parseInactivityThresholdSeconds", () => {
  it("reads seconds and stores milliseconds", () => {
    expect(parseInactivityThresholdSeconds("30")).toEqual({ ok: true, value: 30_000 });
    expect(parseInactivityThresholdSeconds(" 45 ")).toEqual({ ok: true, value: 45_000 });
  });

  it("accepts a day-long threshold", () => {
    expect(parseInactivityThresholdSeconds("86500")).toEqual({ ok: true, value: 86_500_000 });
  });

  it("treats an empty field as a request for the default", () => {
    // Distinct from an error: clearing the box is how a tab gives up its
    // override, so it must not be rejected as unparseable.
    expect(parseInactivityThresholdSeconds("")).toEqual({ ok: true, value: undefined });
    expect(parseInactivityThresholdSeconds("   ")).toEqual({ ok: true, value: undefined });
  });

  it("rejects only what is not a positive duration", () => {
    expect(parseInactivityThresholdSeconds("abc").ok).toBe(false);
    expect(parseInactivityThresholdSeconds("0").ok).toBe(false);
    expect(parseInactivityThresholdSeconds("-5").ok).toBe(false);
  });

  it("accepts a fractional entry by rounding to whole milliseconds", () => {
    expect(parseInactivityThresholdSeconds("7.5")).toEqual({ ok: true, value: 7_500 });
  });
});

describe("formatInactivityThreshold", () => {
  it("shows the default when a tab has no override", () => {
    expect(formatInactivityThreshold(undefined)).toBe("20s");
  });

  it("drops units that are zero", () => {
    expect(formatInactivityThreshold(120_000)).toBe("2m");
    expect(formatInactivityThreshold(3_600_000)).toBe("1h");
  });

  it("keeps a menu row short by showing at most two units", () => {
    // 24h 1m 40s — the seconds are noise at this scale.
    expect(formatInactivityThreshold(86_500_000)).toBe("24h 1m");
    expect(formatInactivityThreshold(90_000)).toBe("1m 30s");
  });
});
