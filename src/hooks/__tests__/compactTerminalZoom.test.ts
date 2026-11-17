import { describe, expect, it } from "vitest";
import { applyCompactTerminalZoom } from "../useTerminalBridge";

describe("pinching a terminal's text on a phone", () => {
  it("leaves the fitted size alone when not pinched", () => {
    expect(applyCompactTerminalZoom(11, 1)).toBe(11);
  });

  it("scales the fitted size, to the nearest half point", () => {
    expect(applyCompactTerminalZoom(11, 1.5)).toBe(16.5);
    expect(applyCompactTerminalZoom(11, 1.37)).toBe(15);
  });

  it("stops at sizes that are still a terminal", () => {
    expect(applyCompactTerminalZoom(11, 0.1)).toBe(5);
    expect(applyCompactTerminalZoom(11, 10)).toBe(40);
  });

  it("ignores a zoom that is not a number", () => {
    expect(applyCompactTerminalZoom(11, Number.NaN)).toBe(11);
    expect(applyCompactTerminalZoom(11, 0)).toBe(11);
  });
});
