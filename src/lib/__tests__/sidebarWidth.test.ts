import { describe, expect, it } from "vitest";
import {
  MIN_SIDEBAR_WIDTH,
  clampSidebarWidth,
  maxSidebarWidth,
} from "../sidebarWidth";

describe("maxSidebarWidth", () => {
  it("allows half the window, not a fixed 480", () => {
    // The old flat ceiling left long tab titles truncated on a large display
    // with most of the window unused.
    expect(maxSidebarWidth(1600)).toBe(800);
    expect(maxSidebarWidth(3000)).toBe(1500);
  });

  it("never goes below the minimum, however small the window", () => {
    // A max under the min inverts the clamp, and the width then pins to
    // whichever bound was applied last rather than to either.
    expect(maxSidebarWidth(200)).toBe(MIN_SIDEBAR_WIDTH);
    expect(maxSidebarWidth(0)).toBe(MIN_SIDEBAR_WIDTH);
    expect(maxSidebarWidth(Number.NaN)).toBe(MIN_SIDEBAR_WIDTH);
  });
});

describe("clampSidebarWidth", () => {
  it("keeps a width that already fits", () => {
    expect(clampSidebarWidth(240, 1600)).toBe(240);
  });

  it("holds both ends", () => {
    expect(clampSidebarWidth(20, 1600)).toBe(MIN_SIDEBAR_WIDTH);
    expect(clampSidebarWidth(5000, 1600)).toBe(800);
  });

  it("pulls a too-wide sidebar back in when the window shrinks", () => {
    // Dragging wide on a large display and then narrowing the window would
    // otherwise leave the terminal with nothing.
    expect(clampSidebarWidth(800, 900)).toBe(450);
  });
});
