import { describe, expect, it } from "vitest";
import { resolveGridBottomAnchorPx } from "../useTerminalBridge";

// The shape measured on a real phone: a 1139px grid in a 412px box.
describe("anchoring the grid to the bottom of its box", () => {
  it("hides exactly the rows that do not fit above the fold", () => {
    expect(resolveGridBottomAnchorPx(1139, 412)).toBe(727);
  });

  it("hides nothing when the grid already fits", () => {
    expect(resolveGridBottomAnchorPx(300, 412)).toBe(0);
  });

  it("hides nothing when the box is exactly the size of the grid", () => {
    expect(resolveGridBottomAnchorPx(412, 412)).toBe(0);
  });

  it("stays put when either side has not been measured", () => {
    expect(resolveGridBottomAnchorPx(1139, 0)).toBe(0);
    expect(resolveGridBottomAnchorPx(0, 412)).toBe(0);
  });
});
