import { describe, expect, it } from "vitest";
import {
  resolveProxyScrollPosition,
  resolveProxySpacerHeight,
} from "../useTerminalBridge";

// The shape measured on a real phone: a 67-row grid, ~24 rows of which fit.
const CELL = 17;
const ROWS = 67;

describe("history scroll proxy mapping", () => {
  it("walks the buffer while the grid still has somewhere to go", () => {
    const { line, offsetPx } = resolveProxyScrollPosition({
      scrollTopPx: 40 * CELL,
      cellHeightPx: CELL,
      bufferLines: 500,
      rows: ROWS,
      baseY: 500 - ROWS,
    });

    expect(line).toBe(40);
    // The grid itself moved, so it does not need shifting.
    expect(offsetPx).toBe(0);
  });

  it("shifts the grid once the buffer cannot scroll any further", () => {
    // Past baseY the terminal is showing its last frame, and the rows below the
    // fold are only reachable by moving the element.
    const baseY = 500 - ROWS;
    const { line, offsetPx } = resolveProxyScrollPosition({
      scrollTopPx: (baseY + 10) * CELL,
      cellHeightPx: CELL,
      bufferLines: 500,
      rows: ROWS,
      baseY,
    });

    expect(line).toBe(baseY);
    expect(offsetPx).toBe(10 * CELL);
  });

  it("never asks for a line past the end of the buffer", () => {
    const { line, offsetPx } = resolveProxyScrollPosition({
      scrollTopPx: 10_000 * CELL,
      cellHeightPx: CELL,
      bufferLines: 500,
      rows: ROWS,
      baseY: 500 - ROWS,
    });

    expect(line).toBe(500 - ROWS);
    expect(offsetPx).toBe((ROWS - 1) * CELL);
  });

  it("stays put when the cell has not been measured", () => {
    expect(
      resolveProxyScrollPosition({
        scrollTopPx: 400,
        cellHeightPx: 0,
        bufferLines: 500,
        rows: ROWS,
        baseY: 433,
      })
    ).toEqual({ line: 0, offsetPx: 0 });
  });

  it("sizes the spacer to the lines the grid does not already occupy", () => {
    // The grid stands in the document for its own rows, so only the scrollback
    // above it needs height adding.
    expect(resolveProxySpacerHeight(500, ROWS, CELL)).toBe((500 - ROWS) * CELL);
  });

  it("asks for no spacer when the buffer fits the grid", () => {
    expect(resolveProxySpacerHeight(20, ROWS, CELL)).toBe(0);
  });
});
