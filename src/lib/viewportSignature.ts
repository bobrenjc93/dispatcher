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
  /** First row that differs, or null when the screens match. */
  firstChangedRow: number | null;
  before: string;
  after: string;
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
    const width = Math.max(previousLine.length, currentLine.length);
    for (let index = 0; index < width; index += 1) {
      if (previousLine[index] !== currentLine[index]) {
        changedChars += 1;
      }
    }
    if (firstChangedRow === null) {
      firstChangedRow = row;
      before = previousLine;
      after = currentLine;
    }
  }

  return { changedRows, changedChars, firstChangedRow, before, after };
}
