import { describe, expect, it } from "vitest";
import { FOLLOW_BOTTOM_TOLERANCE_PX, isScrolledToBottom } from "../useTerminalBridge";

describe("isScrolledToBottom", () => {
  it("follows when pinned to the bottom", () => {
    expect(isScrolledToBottom(600, 1000, 400)).toBe(true);
  });

  it("stops following once the reader scrolls up", () => {
    // The bug this fixes: an agent producing output kept yanking the view back
    // because only xterm's scrollback was consulted, never this box.
    expect(isScrolledToBottom(200, 1000, 400)).toBe(false);
  });

  it("tolerates the fractional slack of a real layout", () => {
    // Visually pinned, a pixel or two short. Without slack, following would
    // switch off the moment output arrived.
    expect(isScrolledToBottom(600 - FOLLOW_BOTTOM_TOLERANCE_PX, 1000, 400)).toBe(true);
    expect(isScrolledToBottom(600 - FOLLOW_BOTTOM_TOLERANCE_PX - 1, 1000, 400)).toBe(false);
  });

  it("counts a box with nothing to scroll as at the bottom", () => {
    expect(isScrolledToBottom(0, 400, 400)).toBe(true);
  });
});
