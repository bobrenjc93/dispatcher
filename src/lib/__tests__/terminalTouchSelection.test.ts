import { describe, expect, it } from "vitest";
import {
  cellFromPoint,
  movedTooFarForLongPress,
  selectionFromCells,
  wordRangeAt,
} from "../terminalTouchSelection";

const geometry = {
  rect: { left: 10, top: 20 },
  cellWidth: 8,
  cellHeight: 16,
  cols: 80,
  rows: 24,
  viewportY: 100,
};

describe("cellFromPoint", () => {
  it("maps a touch to a cell in buffer coordinates", () => {
    // 3 cells right, 2 rows down, on a screen scrolled to buffer row 100.
    expect(cellFromPoint({ x: 10 + 3 * 8 + 2, y: 20 + 2 * 16 + 4, ...geometry }))
      .toEqual({ col: 3, row: 102 });
  });

  it("clamps a finger that lands outside the screen", () => {
    expect(cellFromPoint({ x: -500, y: -500, ...geometry })).toEqual({ col: 0, row: 100 });
    expect(cellFromPoint({ x: 99_999, y: 99_999, ...geometry })).toEqual({ col: 79, row: 123 });
  });

  it("does not divide by a zero cell size", () => {
    expect(cellFromPoint({ x: 50, y: 50, ...geometry, cellWidth: 0 }))
      .toEqual({ col: 0, row: 100 });
  });
});

describe("selectionFromCells", () => {
  it("measures a range on one row", () => {
    expect(selectionFromCells({ col: 4, row: 10 }, { col: 9, row: 10 }, 80))
      .toEqual({ column: 4, row: 10, length: 6 });
  });

  it("measures a range across rows", () => {
    // 76 cells to the end of row 10, a full row 11, then 5 into row 12.
    expect(selectionFromCells({ col: 4, row: 10 }, { col: 8, row: 12 }, 80))
      .toEqual({ column: 4, row: 10, length: 165 });
  });

  it("orders the ends, so dragging backwards works", () => {
    const forward = selectionFromCells({ col: 4, row: 10 }, { col: 8, row: 12 }, 80);
    const backward = selectionFromCells({ col: 8, row: 12 }, { col: 4, row: 10 }, 80);
    expect(backward).toEqual(forward);
  });

  it("never selects nothing", () => {
    expect(selectionFromCells({ col: 4, row: 10 }, { col: 4, row: 10 }, 80).length).toBe(1);
  });
});

describe("wordRangeAt", () => {
  const line = "cargo test --lib";

  it("takes the whole word under the finger", () => {
    expect(wordRangeAt(line, 2)).toEqual({ start: 0, end: 4 });
    expect(wordRangeAt(line, 8)).toEqual({ start: 6, end: 9 });
  });

  it("selects just the cell when the finger lands between words", () => {
    // A finger is imprecise; jumping to a neighbouring word would be worse.
    expect(wordRangeAt(line, 5)).toEqual({ start: 5, end: 5 });
  });

  it("handles a word running to the end of the line", () => {
    expect(wordRangeAt(line, 14)).toEqual({ start: 11, end: 15 });
  });

  it("copes with a column past the text", () => {
    expect(wordRangeAt(line, 200)).toEqual({ start: 200, end: 200 });
  });
});

describe("movedTooFarForLongPress", () => {
  it("tolerates the wobble of a resting finger", () => {
    expect(movedTooFarForLongPress({ x: 100, y: 100 }, { x: 104, y: 96 })).toBe(false);
  });

  it("treats a real drag as a scroll", () => {
    expect(movedTooFarForLongPress({ x: 100, y: 100 }, { x: 100, y: 140 })).toBe(true);
  });
});
