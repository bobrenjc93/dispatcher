import { describe, expect, it } from "vitest";
import { resolveContextMenuPlacement } from "../contextMenuPosition";

const PHONE = { viewportWidth: 390, viewportHeight: 844 };
const DESKTOP = { viewportWidth: 1440, viewportHeight: 900 };

describe("resolveContextMenuPlacement", () => {
  it("leaves a menu where it was asked for when it fits", () => {
    expect(
      resolveContextMenuPlacement({ x: 100, y: 100, width: 200, height: 300, ...DESKTOP })
    ).toEqual({ left: 100, top: 100, maxHeight: null });
  });

  it("flips a menu that would run off the right or the bottom", () => {
    const placement = resolveContextMenuPlacement({
      x: 1380,
      y: 800,
      width: 200,
      height: 300,
      ...DESKTOP,
    });
    expect(placement.left).toBe(1180);
    expect(placement.top).toBe(500);
  });

  it("does not push a flipped menu off the top", () => {
    // What a phone actually does: a dozen two-line rows, pressed halfway down
    // the list. Flipping up put the first items above the screen, where they
    // could not be reached — Push on Inactivity among them.
    const placement = resolveContextMenuPlacement({
      x: 40,
      y: 500,
      width: 260,
      height: 700,
      ...PHONE,
    });
    expect(placement.top).toBeGreaterThanOrEqual(8);
    expect(placement.top + 700).toBeLessThanOrEqual(844 - 8);
  });

  it("makes a menu taller than the screen scroll from the top", () => {
    const placement = resolveContextMenuPlacement({
      x: 40,
      y: 400,
      width: 260,
      height: 1200,
      ...PHONE,
    });
    expect(placement.maxHeight).toBe(844 - 16);
    expect(placement.top).toBe(8);
  });

  it("pulls a menu opened near the right edge fully into view", () => {
    // The case from a phone: pressed 212px across a 461px screen with a menu
    // that naturally wants 250px. Left where it was, its right-hand columns —
    // the shortcut and the tick that says whether Push on Inactivity is on —
    // sit off the screen.
    const placement = resolveContextMenuPlacement({
      x: 212,
      y: 300,
      width: 250,
      height: 500,
      viewportWidth: 461,
      viewportHeight: 844,
    });
    expect(placement.left + 250).toBeLessThanOrEqual(461 - 8);
    expect(placement.left).toBeGreaterThanOrEqual(8);
  });

  it("keeps the near edge visible when the menu is wider than the screen", () => {
    // Nothing fits, so show the side the items start on rather than the side
    // they end on.
    const placement = resolveContextMenuPlacement({
      x: 200,
      y: 100,
      width: 500,
      height: 200,
      ...PHONE,
    });
    expect(placement.left).toBe(8);
  });
});
