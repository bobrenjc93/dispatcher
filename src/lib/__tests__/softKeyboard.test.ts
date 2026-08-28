import { describe, expect, it } from "vitest";
import { computeAppViewportHeight, isSignificantViewportChange } from "../softKeyboard";

describe("computeAppViewportHeight", () => {
  it("uses the window when there is no visual viewport", () => {
    expect(computeAppViewportHeight(null, 800)).toBe(800);
  });

  it("shrinks to the visual viewport when the keyboard is up", () => {
    // 800pt window, ~340pt of keyboard.
    expect(computeAppViewportHeight({ height: 460, offsetTop: 0 }, 800)).toBe(460);
  });

  it("discounts the part scrolled off the top", () => {
    // The browser scrolled the page up to reveal the focused input; that strip
    // is off screen and is not ours to draw in.
    expect(computeAppViewportHeight({ height: 460, offsetTop: 60 }, 800)).toBe(400);
  });

  it("never reports more than the window", () => {
    // Some browsers overshoot mid-animation; growing past the window bounces.
    expect(computeAppViewportHeight({ height: 900, offsetTop: 0 }, 800)).toBe(800);
  });

  it("falls back to the window for nonsense measurements", () => {
    expect(computeAppViewportHeight({ height: 0, offsetTop: 0 }, 800)).toBe(800);
    expect(computeAppViewportHeight({ height: Number.NaN, offsetTop: 0 }, 800)).toBe(800);
    expect(computeAppViewportHeight({ height: 100, offsetTop: 100 }, 800)).toBe(800);
  });
});

describe("isSignificantViewportChange", () => {
  it("ignores sub-pixel noise from the keyboard animation", () => {
    expect(isSignificantViewportChange(460, 460.4)).toBe(false);
  });

  it("reacts to a real change", () => {
    expect(isSignificantViewportChange(800, 460)).toBe(true);
    expect(isSignificantViewportChange(-1, 800)).toBe(true);
  });
});
