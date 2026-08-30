import { describe, expect, it } from "vitest";
import { resolveGridBottomAnchorPx } from "../useTerminalBridge";

// Measured on a real phone, from the [006/a] burner tab: 67 rows at 14px is a
// 938px grid, rendered inside a 597px element. The 341px difference is what
// has to be hidden above the fold for the last row to sit on the bottom edge.
const GRID = 938;
const ELEMENT = 597;
const ROW = 14;

describe("anchoring the grid to the bottom of its box", () => {
  it("hides exactly the rows that do not fit", () => {
    expect(resolveGridBottomAnchorPx(GRID, ELEMENT, ROW)).toBe(341);
  });

  it("measures against the element, not the padded box around it", () => {
    // The container is 601px: the element is 597 because of the container's
    // 4px padding. Anchoring against the container leaves the last row hanging
    // 4px past the bottom, sliced through — which is what it did.
    expect(resolveGridBottomAnchorPx(GRID, 601, ROW)).toBe(337);
    expect(resolveGridBottomAnchorPx(GRID, ELEMENT, ROW)).toBe(341);
  });

  it("hides nothing when the grid already fits", () => {
    // The default 80x24 grid: 408px in a 412px box, nothing above the fold.
    expect(resolveGridBottomAnchorPx(408, 412, 17)).toBe(0);
  });

  it("refuses a box too small to show a single row", () => {
    // What a tab mid-switch measures as. Anchoring against it moves the grid
    // off screen entirely, and no gesture brings it back.
    expect(resolveGridBottomAnchorPx(GRID, 1, ROW)).toBe(0);
    expect(resolveGridBottomAnchorPx(GRID, ROW - 1, ROW)).toBe(0);
    expect(resolveGridBottomAnchorPx(GRID, ROW, ROW)).toBe(GRID - ROW);
  });

  it("stays put when nothing has been measured", () => {
    expect(resolveGridBottomAnchorPx(GRID, 0, ROW)).toBe(0);
    expect(resolveGridBottomAnchorPx(0, ELEMENT, ROW)).toBe(0);
    expect(resolveGridBottomAnchorPx(GRID, ELEMENT, 0)).toBe(0);
  });
});
