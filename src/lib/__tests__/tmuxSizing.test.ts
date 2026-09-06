import { describe, expect, it } from "vitest";

import {
  MIN_TMUX_WINDOW_COLS,
  MIN_TMUX_WINDOW_ROWS,
  computeTmuxWindowSizeFromPaneViewport,
  isUsableTmuxWindowSize,
} from "../tmuxSizing";

describe("computeTmuxWindowSizeFromPaneViewport", () => {
  it("matches the active pane viewport directly for a single-pane window", () => {
    expect(
      computeTmuxWindowSizeFromPaneViewport({
        viewportWidthPx: 796,
        viewportHeightPx: 396,
        cellWidthPx: 8,
        cellHeightPx: 18,
        activePaneCols: 100,
        activePaneRows: 22,
        totalWindowCols: 100,
        totalWindowRows: 22,
      })
    ).toEqual({ cols: 99, rows: 22 });
  });

  it("scales from the active pane to infer the full tmux window size", () => {
    expect(
      computeTmuxWindowSizeFromPaneViewport({
        viewportWidthPx: 388,
        viewportHeightPx: 396,
        cellWidthPx: 8,
        cellHeightPx: 18,
        activePaneCols: 49,
        activePaneRows: 22,
        totalWindowCols: 100,
        totalWindowRows: 22,
      })
    ).toEqual({ cols: 98, rows: 22 });
  });

  it("returns null when the input metrics are invalid", () => {
    expect(
      computeTmuxWindowSizeFromPaneViewport({
        viewportWidthPx: 0,
        viewportHeightPx: 396,
        cellWidthPx: 8,
        cellHeightPx: 18,
        activePaneCols: 49,
        activePaneRows: 22,
        totalWindowCols: 100,
        totalWindowRows: 22,
      })
    ).toBeNull();
  });
});

describe("isUsableTmuxWindowSize", () => {
  it("rejects the grid a zero-sized container produces", () => {
    // A hidden or not-yet-laid-out element measures 0x0, which floors to
    // nothing and is clamped to 2x1 by the callers. Sent to tmux that reflows
    // the pane to two columns and destroys every line of its content.
    expect(isUsableTmuxWindowSize(2, 1)).toBe(false);
  });

  it("rejects anything too small to be a real terminal", () => {
    expect(isUsableTmuxWindowSize(19, 40)).toBe(false);
    expect(isUsableTmuxWindowSize(80, 3)).toBe(false);
    expect(isUsableTmuxWindowSize(Number.NaN, 40)).toBe(false);
  });

  it("accepts ordinary window sizes, including a narrow phone", () => {
    expect(isUsableTmuxWindowSize(119, 51)).toBe(true);
    expect(isUsableTmuxWindowSize(88, 67)).toBe(true);
    // A phone in portrait is the smallest thing that must still work.
    expect(isUsableTmuxWindowSize(40, 60)).toBe(true);
    expect(isUsableTmuxWindowSize(MIN_TMUX_WINDOW_COLS, MIN_TMUX_WINDOW_ROWS)).toBe(true);
  });
});
