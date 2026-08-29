import { describe, expect, it } from "vitest";
import { dragActivationThreshold, exceedsDragThreshold } from "../dragState";

describe("drag activation threshold", () => {
  it("stays tight for a mouse", () => {
    expect(dragActivationThreshold("mouse")).toBe(5);
    expect(dragActivationThreshold(undefined)).toBe(5);
    expect(exceedsDragThreshold(4, 3, "mouse")).toBe(true);
    expect(exceedsDragThreshold(2, 2, "mouse")).toBe(false);
  });

  it("tolerates the wobble of a tap", () => {
    // The case that broke tab switching: 3 across and 4 down sums to 7, over a
    // mouse's budget, so the tap became a drag and its click was swallowed.
    expect(exceedsDragThreshold(3, 4, "touch")).toBe(false);
    expect(exceedsDragThreshold(-5, 6, "touch")).toBe(false);
  });

  it("still lets a finger drag deliberately", () => {
    expect(exceedsDragThreshold(0, 40, "touch")).toBe(true);
    expect(exceedsDragThreshold(20, 10, "touch")).toBe(true);
  });

  it("treats a pen like a finger", () => {
    expect(dragActivationThreshold("pen")).toBe(dragActivationThreshold("touch"));
  });
});
