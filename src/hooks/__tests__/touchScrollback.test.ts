import { describe, expect, it } from "vitest";
import { consumeTouchScrollLines } from "../useTerminalBridge";

describe("touch scrollback", () => {
  it("carries the remainder so a slow drag still moves", () => {
    // A finger produces many small deltas. Rounding each one on its own throws
    // nearly all of them away, and the history never moves.
    const cellHeight = 15;
    let carryLines = 0;
    let scrolled = 0;

    for (let move = 0; move < 15; move += 1) {
      const step = consumeTouchScrollLines(carryLines, 5, cellHeight);
      carryLines = step.carryLines;
      scrolled += step.lines;
    }

    // 15 moves of 5px over a 15px cell is five whole lines.
    expect(scrolled).toBe(5);
  });

  it("scrolls towards newer output when the finger travels up", () => {
    const { lines } = consumeTouchScrollLines(0, 30, 15);
    expect(lines).toBe(2);
  });

  it("scrolls back through history when the finger travels down", () => {
    const { lines } = consumeTouchScrollLines(0, -30, 15);
    expect(lines).toBe(-2);
  });

  it("ignores an unmeasured cell rather than scrolling wildly", () => {
    expect(consumeTouchScrollLines(0.5, 40, 0)).toEqual({ lines: 0, carryLines: 0.5 });
  });
});
