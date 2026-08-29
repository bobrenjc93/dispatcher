/**
 * Selecting a range of terminal text with a finger.
 *
 * The terminal draws through WebGL, so there is no DOM text for the browser to
 * select, and xterm's own selection is driven by mouse drags a touchscreen
 * never produces. On a phone `.terminal-container` also scrolls, so a plain
 * drag is already spoken for.
 *
 * So selection is a mode: long-press to enter it — which is a gesture scrolling
 * does not use — then drag to move the far end of the range. This module owns
 * the arithmetic; the listeners live with the terminal instance.
 */

/** A cell in buffer coordinates: `row` includes scrollback, as xterm's API wants. */
export interface TerminalCell {
  col: number;
  row: number;
}

export interface CellFromPointArgs {
  x: number;
  y: number;
  rect: { left: number; top: number };
  cellWidth: number;
  cellHeight: number;
  cols: number;
  rows: number;
  /** First visible buffer row, so the result is absolute. */
  viewportY: number;
}

/** Which cell a touch landed on, clamped to the screen. */
export function cellFromPoint(args: CellFromPointArgs): TerminalCell {
  const { x, y, rect, cellWidth, cellHeight, cols, rows, viewportY } = args;
  if (cellWidth <= 0 || cellHeight <= 0) {
    return { col: 0, row: viewportY };
  }

  const col = clamp(Math.floor((x - rect.left) / cellWidth), 0, Math.max(0, cols - 1));
  const viewportRow = clamp(Math.floor((y - rect.top) / cellHeight), 0, Math.max(0, rows - 1));
  return { col, row: viewportY + viewportRow };
}

/**
 * Turn two cells into the arguments xterm's `select` wants.
 *
 * Either end may be the one the finger is on, since a range can be dragged
 * backwards, so they are ordered here rather than at the call site.
 */
export function selectionFromCells(
  anchor: TerminalCell,
  focus: TerminalCell,
  cols: number
): { column: number; row: number; length: number } {
  const [start, end] = isBefore(anchor, focus) ? [anchor, focus] : [focus, anchor];
  const length = (end.row - start.row) * cols + (end.col - start.col) + 1;
  return { column: start.col, row: start.row, length: Math.max(1, length) };
}

function isBefore(a: TerminalCell, b: TerminalCell): boolean {
  return a.row < b.row || (a.row === b.row && a.col <= b.col);
}

const WORD_SEPARATORS = new Set([..." \t()[]{}'\"`,;:|<>"]);

/**
 * The word under a column, for what a long-press should start with.
 *
 * Landing on whitespace selects just that cell: a finger is imprecise, and
 * silently jumping to a neighbouring word is worse than selecting nothing much.
 */
export function wordRangeAt(line: string, col: number): { start: number; end: number } {
  if (col < 0 || col >= line.length || WORD_SEPARATORS.has(line[col])) {
    return { start: col, end: col };
  }

  let start = col;
  while (start > 0 && !WORD_SEPARATORS.has(line[start - 1])) {
    start -= 1;
  }
  let end = col;
  while (end < line.length - 1 && !WORD_SEPARATORS.has(line[end + 1])) {
    end += 1;
  }
  return { start, end };
}

/** A press that moved this far was a scroll, not a long-press. */
export const LONG_PRESS_SLOP_PX = 10;
/** How long a finger must rest before selection takes over from scrolling. */
export const LONG_PRESS_MS = 450;

export function movedTooFarForLongPress(
  from: { x: number; y: number },
  to: { x: number; y: number }
): boolean {
  return (
    Math.abs(to.x - from.x) > LONG_PRESS_SLOP_PX
    || Math.abs(to.y - from.y) > LONG_PRESS_SLOP_PX
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
