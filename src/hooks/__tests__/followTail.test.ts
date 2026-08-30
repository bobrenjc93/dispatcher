import { describe, expect, it } from "vitest";
import { shouldFollowTailAfterScroll } from "../useTerminalBridge";

describe("following the tail after a hand-driven scroll", () => {
  it("does not pin while a scroll is still in flight", () => {
    // The regression this exists for: an upward swipe starts at the bottom, so
    // a check taken mid-gesture agrees it is at the bottom and pins the reader
    // straight back. On a pane that never stops emitting, every attempt to
    // scroll up got cancelled.
    expect(
      shouldFollowTailAfterScroll({ atBottom: true, msSinceUserScroll: 0, settleMs: 400 })
    ).toBe(false);
  });

  it("still pins once the scroll has settled at the bottom", () => {
    expect(
      shouldFollowTailAfterScroll({ atBottom: true, msSinceUserScroll: 400, settleMs: 400 })
    ).toBe(true);
  });

  it("leaves a reader who scrolled away alone however long they sit there", () => {
    expect(
      shouldFollowTailAfterScroll({ atBottom: false, msSinceUserScroll: 10_000, settleMs: 400 })
    ).toBe(false);
  });
});
