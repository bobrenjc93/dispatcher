import { describe, expect, it } from "vitest";
import { shouldBounceDock } from "../dockAttention";

const base = {
  enabled: true,
  wasNeedsAttention: false,
  nextNeedsAttention: true,
  documentHasFocus: false,
};

describe("shouldBounceDock", () => {
  it("bounces when a background tab starts needing attention", () => {
    expect(shouldBounceDock(base)).toBe(true);
  });

  it("stays quiet unless the tab opted in", () => {
    expect(shouldBounceDock({ ...base, enabled: false })).toBe(false);
  });

  it("bounces on the edge only, not for every sample while attention persists", () => {
    expect(shouldBounceDock({ ...base, wasNeedsAttention: true })).toBe(false);
  });

  it("does not bounce for a tab that no longer needs attention", () => {
    expect(shouldBounceDock({ ...base, nextNeedsAttention: false })).toBe(false);
  });

  it("does not bounce while Dispatcher is the window in front of you", () => {
    // Whichever tab is open. A bounce pulls someone back from another app, and
    // there is nothing to pull them back from; the sidebar dot already says a
    // background tab wants looking at.
    expect(shouldBounceDock({ ...base, documentHasFocus: true })).toBe(false);
  });

  it("bounces when Dispatcher is in the background", () => {
    // The whole point is pulling the user back from another app.
    expect(shouldBounceDock({ ...base, documentHasFocus: false })).toBe(true);
  });
});
