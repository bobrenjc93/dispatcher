import { describe, expect, it } from "vitest";
import { resolveGridBottomAnchorPx } from "../useTerminalBridge";

// The shape measured on a real phone: a 1139px grid in a 412px box.
describe("anchoring the grid to the bottom of its box", () => {
  it("hides exactly the rows that do not fit above the fold", () => {
    expect(resolveGridBottomAnchorPx(1139, 412, 17)).toBe(727);
  });

  it("hides nothing when the grid already fits", () => {
    expect(resolveGridBottomAnchorPx(300, 412, 17)).toBe(0);
  });

  it("hides nothing when the box is exactly the size of the grid", () => {
    expect(resolveGridBottomAnchorPx(412, 412, 17)).toBe(0);
  });

  it("never hides the whole grid, however small the box measures", () => {
    // A tab mid-switch can measure as almost nothing. Anchoring against that
    // pulls the grid clean off the top of the screen — the reader sees the
    // last row at the top, or a blank pane, and cannot scroll back to it.
    // One pixel of box cannot show a 17px row, so there is nothing to anchor to.
    expect(resolveGridBottomAnchorPx(1139, 1, 17)).toBe(0);
    expect(resolveGridBottomAnchorPx(1139, 16, 17)).toBe(0);
    // A box that can show a row is a real viewport again.
    expect(resolveGridBottomAnchorPx(1139, 17, 17)).toBe(1122);
  });

  it("anchors against the room the grid actually has, not the padded box", () => {
    // The container carries 4px of top padding. Anchoring against the padded
    // height leaves the last row hanging 4px past the bottom edge, clipped
    // through with no way to scroll to it.
    const paddedBox = 412;
    const contentBox = paddedBox - 4;

    expect(resolveGridBottomAnchorPx(1139, contentBox, 17)).toBe(731);
    expect(resolveGridBottomAnchorPx(1139, paddedBox, 17)).toBe(727);
  });

  it("stays put when either side has not been measured", () => {
    expect(resolveGridBottomAnchorPx(1139, 0, 17)).toBe(0);
    expect(resolveGridBottomAnchorPx(0, 412, 17)).toBe(0);
  });
});
