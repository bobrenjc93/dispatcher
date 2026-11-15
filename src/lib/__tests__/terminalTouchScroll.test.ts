import { describe, expect, it } from "vitest";
import {
  maxVerticalScrollOffset,
  resolveVerticalScroll,
  TouchVelocityTracker,
  verticalScrollOffset,
  type VerticalScrollState,
} from "../terminalTouchScroll";

const ROW = 15;

/** A grid 10 rows taller than the screen, sitting on 200 lines of history. */
function atNewest(overrides: Partial<VerticalScrollState> = {}): VerticalScrollState {
  return {
    viewportY: 200,
    baseY: 200,
    scrollTop: 10 * ROW,
    maxScrollTop: 10 * ROW,
    rowHeightPx: ROW,
    ...overrides,
  };
}

function move(state: VerticalScrollState, deltaPx: number) {
  return resolveVerticalScroll(state, verticalScrollOffset(state) + deltaPx);
}

describe("one vertical axis over the history and the grid", () => {
  it("pans the grid first, by the pixel, without touching the history", () => {
    const placement = move(atNewest(), -7);

    expect(placement.viewportY).toBe(200);
    expect(placement.scrollTop).toBe(10 * ROW - 7);
    expect(placement.atEdge).toBe(false);
  });

  it("runs on into the history once the grid is at its top", () => {
    // The top of the screen starts on line 210 (200 of history, 10 rows down
    // the grid). 12 rows up is 10 of grid, then 2 of history.
    const placement = move(atNewest(), -12 * ROW);

    expect(placement.viewportY + placement.scrollTop / ROW).toBe(198);
    expect(placement.viewportY).toBeLessThan(200);
  });

  it("keeps moving by the pixel inside the history when the grid overflows", () => {
    const top = atNewest({ scrollTop: 0 });
    const placement = move(top, -4);

    // xterm takes a whole line and the box gives back all but 4px of it, so
    // the screen moves 4px rather than a whole row.
    expect(placement.viewportY).toBe(199);
    expect(placement.scrollTop).toBe(ROW - 4);
  });

  it("comes back down through the history before the grid", () => {
    const inHistory = atNewest({ viewportY: 150, scrollTop: 0 });
    const placement = move(inHistory, 60 * ROW);

    // 50 lines of history, then 10 rows of grid, lands exactly on the newest.
    expect(placement.viewportY).toBe(200);
    expect(placement.scrollTop).toBe(10 * ROW);
  });

  it("stops at the oldest line and says so", () => {
    const placement = move(atNewest(), -1_000_000);

    expect(placement.viewportY).toBe(0);
    expect(placement.scrollTop).toBe(0);
    expect(placement.atEdge).toBe(true);
  });

  it("stops at the newest output and says so", () => {
    const placement = move(atNewest(), 50);

    expect(placement.offsetPx).toBe(maxVerticalScrollOffset(atNewest()));
    expect(placement.atEdge).toBe(true);
  });

  it("steps whole lines when the grid fits the screen", () => {
    const fits = atNewest({ scrollTop: 0, maxScrollTop: 0 });
    const placement = move(fits, -4);

    expect(placement.viewportY).toBe(199);
    expect(placement.scrollTop).toBe(0);
    // The 4px asked for is kept as the target, so further small moves add up
    // instead of each jumping another line.
    expect(placement.offsetPx).toBe(200 * ROW - 4);
  });

  it("only pans on the alternate screen, which has no history", () => {
    const alt = atNewest({ viewportY: 0, baseY: 0 });
    const placement = move(alt, -12 * ROW);

    expect(placement.viewportY).toBe(0);
    expect(placement.scrollTop).toBe(0);
    expect(placement.atEdge).toBe(true);
  });

  it("does nothing before the cells are measured", () => {
    const unmeasured = atNewest({ rowHeightPx: 0 });
    const placement = resolveVerticalScroll(unmeasured, 0);

    expect(placement.viewportY).toBe(200);
    expect(placement.scrollTop).toBe(10 * ROW);
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
