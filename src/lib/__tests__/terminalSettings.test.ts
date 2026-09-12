import { describe, expect, it } from "vitest";
import { toSessionPatch } from "../terminalSettings";

describe("toSessionPatch", () => {
  it("passes the settings through", () => {
    expect(toSessionPatch({ pushOnInaction: true, isPinnedGray: false })).toEqual({
      pushOnInaction: true,
      isPinnedGray: false,
    });
  });

  it("reads null as clearing the value", () => {
    // `undefined` does not survive the trip to the desktop, so the wire form
    // says null and the store learns undefined.
    expect(toSessionPatch({ snoozedUntil: null })).toEqual({ snoozedUntil: undefined });
    expect(toSessionPatch({ inactivityThresholdMs: null })).toEqual({
      inactivityThresholdMs: undefined,
    });
  });

  it("leaves out what was not mentioned", () => {
    // Anything present, even as undefined, would overwrite a setting the
    // patch was never about.
    expect(Object.keys(toSessionPatch({ pushOnInaction: true }))).toEqual(["pushOnInaction"]);
    expect(toSessionPatch({})).toEqual({});
  });

  it("keeps a snooze deadline", () => {
    expect(toSessionPatch({ snoozedUntil: 1234 })).toEqual({ snoozedUntil: 1234 });
  });
});
