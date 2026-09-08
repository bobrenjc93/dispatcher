/**
 * A short stand-in for a pane's visible screen.
 *
 * Used to answer one question: did that output actually change anything? A
 * background tab's status is driven by "bytes arrived", because nothing is
 * rendering it and there is no screen to look at. But a TUI that repaints its
 * whole frame on an internal timer sends thousands of bytes and leaves the
 * screen exactly as it was, and the tab lights up as though the agent had
 * gone back to work.
 *
 * Comparing captures answers it directly. Keeping a hash rather than the text
 * matters at this scale: a hundred-column pane is several kilobytes, and there
 * are dozens of panes.
 */

/**
 * FNV-1a over the captured lines, salted with the total length.
 *
 * A collision would mean one missed revert — a tab left green that could have
 * gone back to brown — so the failure direction is the harmless one.
 */
export function hashViewportLines(lines: readonly string[]): string {
  let hash = 0x811c9dc5;
  let length = 0;
  for (const line of lines) {
    for (let index = 0; index < line.length; index += 1) {
      hash ^= line.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    // Fold in the line break, so moving text between lines is a change.
    hash ^= 0x0a;
    hash = Math.imul(hash, 0x01000193);
    length += line.length + 1;
  }
  return `${length}:${(hash >>> 0).toString(16)}`;
}

export type ViewportChangeVerdict = "changed" | "unchanged" | "unknown";

/**
 * Whether a capture shows the screen changed since the last one.
 *
 * `unknown` is a real answer and the important one: with no baseline to
 * compare against, or with more output already landed after the capture was
 * taken, the honest response is that we cannot say. Callers treat it the same
 * as "changed", because leaving a tab green costs a glance and wrongly
 * clearing one costs the tab you were waiting on.
 */
export function resolveViewportChange(args: {
  signature: string;
  previousSignature: string | null;
}): ViewportChangeVerdict {
  if (args.previousSignature === null) {
    return "unknown";
  }
  return args.signature === args.previousSignature ? "unchanged" : "changed";
}

export interface ViewportChangeDescription {
  changedRows: number;
  changedChars: number;
  /** The same two counts with styling removed, which is what a person reads. */
  changedTextRows: number;
  changedTextChars: number;
  /** First row that differs, or null when the screens match. */
  firstChangedRow: number | null;
  before: string;
  after: string;
}

/**
 * A row as read rather than as drawn.
 *
 * Captures come from `capture-pane -e`, so a row is mostly colour codes. A
 * TUI recolouring one glyph rewrites hundreds of "characters" while saying
 * nothing, and counting those is how a spinner passes for work.
 */
export function stripViewportStyling(line: string): string {
  return line.replace(/\u001b\[[0-9;:?]*[ -/]*[@-~]/g, "");
}

/**
 * What actually differs between two captures.
 *
 * For the log rather than for a decision. When a tab wakes after being quiet
 * for an hour, the question is always the same — what changed? — and answering
 * it from a byte count is guesswork. Reporting the first differing row, both
 * versions of it, turns that into a fact.
 */
export function describeViewportChange(
  previous: readonly string[],
  current: readonly string[]
): ViewportChangeDescription {
  const rows = Math.max(previous.length, current.length);
  let changedRows = 0;
  let changedChars = 0;
  let changedTextRows = 0;
  let changedTextChars = 0;
  let firstChangedRow: number | null = null;
  let before = "";
  let after = "";

  for (let row = 0; row < rows; row += 1) {
    const previousLine = previous[row] ?? "";
    const currentLine = current[row] ?? "";
    if (previousLine === currentLine) {
      continue;
    }
    changedRows += 1;
    changedChars += countDifferingChars(previousLine, currentLine);

    const previousText = stripViewportStyling(previousLine);
    const currentText = stripViewportStyling(currentLine);
    if (previousText !== currentText) {
      changedTextRows += 1;
      changedTextChars += countDifferingChars(previousText, currentText);
    }

    if (firstChangedRow === null) {
      firstChangedRow = row;
      before = previousLine;
      after = currentLine;
    }
  }

  return {
    changedRows,
    changedChars,
    changedTextRows,
    changedTextChars,
    firstChangedRow,
    before,
    after,
  };
}

function countDifferingChars(previous: string, current: string): number {
  const width = Math.max(previous.length, current.length);
  let differing = 0;
  for (let index = 0; index < width; index += 1) {
    if (previous[index] !== current[index]) {
      differing += 1;
    }
  }
  return differing;
}

/**
 * How much a screen may change and still be decoration rather than work.
 *
 * Measured, not guessed. Thirty-one wakes that were real work rewrote 38 rows
 * at the least and thousands of characters. The spinner tick that kept waking
 * an idle pr-review tab moved four rows and a handful of glyphs: a grey space
 * becoming a green bullet beside a `sleep 240` that was still sleeping.
 * Nothing observed falls between the two.
 */
const DECORATION_MAX_TEXT_ROWS = 8;
const DECORATION_MAX_TEXT_CHARS = 12;

/**
 * Whether a change is a TUI redrawing its own furniture.
 *
 * Judged on the text, because that is what a person reads: a recolour with
 * identical text is always decoration, however many bytes it took. A tab that
 * this holds back is one whose agent is sitting on a long tool call — the
 * spinner turning is not news, and treating it as news is what made "green"
 * stop meaning anything.
 */
export function isDecorationOnlyChange(change: ViewportChangeDescription): boolean {
  if (change.changedRows === 0) {
    return false;
  }
  return (
    change.changedTextRows <= DECORATION_MAX_TEXT_ROWS
    && change.changedTextChars <= DECORATION_MAX_TEXT_CHARS
  );
}
