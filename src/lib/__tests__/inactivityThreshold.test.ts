import { describe, expect, it } from "vitest";
import {
  DEFAULT_INACTIVITY_THRESHOLD_MS,
  MAX_INACTIVITY_THRESHOLD_MS,
  MIN_INACTIVITY_THRESHOLD_MS,
  formatInactivityThreshold,
  parseInactivityThresholdSeconds,
  resolveInactivityThresholdMs,
} from "../inactivityThreshold";

describe("resolveInactivityThresholdMs", () => {
  it("falls back to the default when a tab has no override", () => {
    expect(resolveInactivityThresholdMs(undefined)).toBe(DEFAULT_INACTIVITY_THRESHOLD_MS);
  });

  it("uses a tab's own value when it is usable", () => {
    expect(resolveInactivityThresholdMs(45_000)).toBe(45_000);
  });

  it("falls back rather than propagating an unusable value", () => {
    // These are reachable from replicated workspace state, not just from the
    // dialog, so a tab whose status silently never updates again is the risk.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 1]) {
      expect(resolveInactivityThresholdMs(bad)).toBe(DEFAULT_INACTIVITY_THRESHOLD_MS);
    }
    expect(resolveInactivityThresholdMs(MAX_INACTIVITY_THRESHOLD_MS + 1)).toBe(
      DEFAULT_INACTIVITY_THRESHOLD_MS
    );
  });

  it("accepts the exact bounds", () => {
    expect(resolveInactivityThresholdMs(MIN_INACTIVITY_THRESHOLD_MS)).toBe(
      MIN_INACTIVITY_THRESHOLD_MS
    );
    expect(resolveInactivityThresholdMs(MAX_INACTIVITY_THRESHOLD_MS)).toBe(
      MAX_INACTIVITY_THRESHOLD_MS
    );
  });
});

describe("parseInactivityThresholdSeconds", () => {
  it("reads seconds and stores milliseconds", () => {
    expect(parseInactivityThresholdSeconds("30")).toEqual({ ok: true, value: 30_000 });
    expect(parseInactivityThresholdSeconds(" 45 ")).toEqual({ ok: true, value: 45_000 });
  });

  it("treats an empty field as a request for the default", () => {
    // Distinct from an error: clearing the box is how a tab gives up its
    // override, so it must not be rejected as unparseable.
    expect(parseInactivityThresholdSeconds("")).toEqual({ ok: true, value: undefined });
    expect(parseInactivityThresholdSeconds("   ")).toEqual({ ok: true, value: undefined });
  });

  it("rejects rather than silently correcting", () => {
    expect(parseInactivityThresholdSeconds("abc").ok).toBe(false);
    expect(parseInactivityThresholdSeconds("1").ok).toBe(false);
    expect(parseInactivityThresholdSeconds("99999").ok).toBe(false);
  });

  it("accepts a fractional entry by rounding to whole milliseconds", () => {
    expect(parseInactivityThresholdSeconds("7.5")).toEqual({ ok: true, value: 7_500 });
  });
});

describe("formatInactivityThreshold", () => {
  it("shows the default when a tab has no override", () => {
    expect(formatInactivityThreshold(undefined)).toBe("20s");
  });

  it("prefers minutes once the value divides evenly", () => {
    expect(formatInactivityThreshold(120_000)).toBe("2m");
    expect(formatInactivityThreshold(90_000)).toBe("90s");
  });
});
