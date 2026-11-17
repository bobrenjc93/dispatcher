import { describe, expect, it } from "vitest";
import {
  consumeTouchScrollLines,
  shouldScrollHistory,
  TouchVelocityTracker,
} from "../terminalTouchScroll";

/** At the newest output, 200 lines of history above the grid. */
const atNewest = { viewportY: 200, baseY: 200 };

describe("who a swipe belongs to", () => {
  it("leaves panning the grid to the browser", () => {
    // Up, towards the bottom of a grid taller than the screen.
    expect(shouldScrollHistory({ ...atNewest, dx: 1, dy: -6, scrollTop: 40 })).toBe(false);
    // Down, back towards the top of the grid.
    expect(shouldScrollHistory({ ...atNewest, dx: 0, dy: 6, scrollTop: 40 })).toBe(false);
  });

  it("runs on into the history when pulled down from the top of the grid", () => {
    expect(shouldScrollHistory({ ...atNewest, dx: 1, dy: 6, scrollTop: 0 })).toBe(true);
  });

  it("does not take a push up at the top of the grid", () => {
    expect(shouldScrollHistory({ ...atNewest, dx: 0, dy: -6, scrollTop: 0 })).toBe(false);
  });

  it("keeps every vertical swipe while reading back through the history", () => {
    const reading = { viewportY: 150, baseY: 200 };
    expect(shouldScrollHistory({ ...reading, dx: 0, dy: -6, scrollTop: 0 })).toBe(true);
    expect(shouldScrollHistory({ ...reading, dx: 0, dy: 6, scrollTop: 0 })).toBe(true);
  });

  it("always pans sideways, even in the history", () => {
    const reading = { viewportY: 150, baseY: 200 };
    expect(shouldScrollHistory({ ...reading, dx: -8, dy: 3, scrollTop: 0 })).toBe(false);
  });

  it("has nothing to take on the alternate screen", () => {
    expect(shouldScrollHistory({ viewportY: 0, baseY: 0, dx: 0, dy: 6, scrollTop: 0 })).toBe(false);
  });
});

describe("touch scrollback", () => {
  it("carries the remainder so a slow drag still moves", () => {
    // A finger produces many small deltas. Rounding each one on its own throws
    // nearly all of them away, and the history never moves.
    let carryLines = 0;
    let scrolled = 0;
    for (let move = 0; move < 15; move += 1) {
      const step = consumeTouchScrollLines(carryLines, 5, 15);
      carryLines = step.carryLines;
      scrolled += step.lines;
    }
    // 15 moves of 5px over a 15px cell is five whole lines.
    expect(scrolled).toBe(5);
  });

  it("scrolls back through history when the finger travels down", () => {
    expect(consumeTouchScrollLines(0, -30, 15).lines).toBe(-2);
  });

  it("ignores an unmeasured cell rather than scrolling wildly", () => {
    expect(consumeTouchScrollLines(0.5, 40, 0)).toEqual({ lines: 0, carryLines: 0.5 });
  });
});

describe("release velocity", () => {
  it("measures the speed the finger was moving as it lifted", () => {
    const tracker = new TouchVelocityTracker();
    tracker.reset(0, 0, 0);
    for (let t = 10; t <= 100; t += 10) {
      tracker.add(0, t * 2, t);
    }

    expect(tracker.velocity(100).y).toBeCloseTo(2, 5);
  });

  it("reads a finger that stopped before lifting as stopped", () => {
    const tracker = new TouchVelocityTracker();
    tracker.reset(0, 0, 0);
    tracker.add(0, 100, 20);
    tracker.add(0, 200, 40);

    expect(tracker.velocity(300)).toEqual({ x: 0, y: 0 });
  });

  it("judges by the last moments, not the whole drag", () => {
    const tracker = new TouchVelocityTracker();
    tracker.reset(0, 0, 0);
    // A fast start, then a slow finish.
    tracker.add(0, 400, 100);
    for (let t = 110; t <= 300; t += 10) {
      tracker.add(0, 400 + (t - 100) * 0.1, t);
    }

    expect(tracker.velocity(300).y).toBeCloseTo(0.1, 5);
  });
});
