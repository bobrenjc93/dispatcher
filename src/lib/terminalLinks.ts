import type { IBufferRange } from "@xterm/xterm";

const MAX_LINK_WINDOW_LINES = 8;
const MAX_LINK_WINDOW_CHARS = 4096;

// Mirrors xterm's web-links URL shape, but we run it across a reconstructed
// logical row instead of only trusting the row-local text that was hovered.
const TERMINAL_URL_REGEX = /https?:\/\/[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/gi;

const URL_CONTINUATION_START = /^[A-Za-z0-9/?#%&=._~:+@,;~-]/;
const URL_CONTINUATION_END = /[A-Za-z0-9/?#%&=._~:+@,;~-]$/;

export interface TerminalWebLinkMatch {
  text: string;
  range: IBufferRange;
}

interface BufferLineLike {
  readonly isWrapped: boolean;
  readonly length: number;
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
}

interface TerminalLike {
  cols: number;
  buffer: {
    active: {
      getLine(y: number): BufferLineLike | undefined;
    };
  };
}

interface LogicalLineSegment {
  bufferY: number;
  text: string;
}

interface IndexedSegment extends LogicalLineSegment {
  start: number;
  end: number;
}

function getTrimmedLineText(line: BufferLineLike): string {
  return line.translateToString(true);
}

function isValidHttpUrl(text: string): boolean {
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isLikelyHardWrappedUrlContinuation(
  previousText: string,
  nextText: string,
  cols: number
): boolean {
  if (!previousText || !nextText) {
    return false;
  }

  // Only infer a missing soft-wrap marker when the previous row reached the
  // terminal width. This avoids joining ordinary adjacent lines that merely
  // happen to end/start with URL-safe characters.
  if (previousText.length < cols) {
    return false;
  }

  return URL_CONTINUATION_END.test(previousText) && URL_CONTINUATION_START.test(nextText);
}

function shouldJoinPreviousLine(
  terminal: TerminalLike,
  previousLine: BufferLineLike,
  currentLine: BufferLineLike
): boolean {
  if (currentLine.isWrapped) {
    return true;
  }

  return isLikelyHardWrappedUrlContinuation(
    getTrimmedLineText(previousLine),
    getTrimmedLineText(currentLine),
    terminal.cols
  );
}

function shouldJoinNextLine(
  terminal: TerminalLike,
  currentLine: BufferLineLike,
  nextLine: BufferLineLike
): boolean {
  if (nextLine.isWrapped) {
    return true;
  }

  return isLikelyHardWrappedUrlContinuation(
    getTrimmedLineText(currentLine),
    getTrimmedLineText(nextLine),
    terminal.cols
  );
}

function getLogicalLineSegments(
  terminal: TerminalLike,
  bufferLineNumber: number
): LogicalLineSegment[] {
  const buffer = terminal.buffer.active;
  let startY = bufferLineNumber - 1;
  let endY = bufferLineNumber - 1;
  let totalChars = 0;

  for (let i = 0; i < MAX_LINK_WINDOW_LINES; i += 1) {
    const currentLine = buffer.getLine(startY);
    const previousLine = buffer.getLine(startY - 1);
    if (!currentLine || !previousLine || !shouldJoinPreviousLine(terminal, previousLine, currentLine)) {
      break;
    }

    totalChars += getTrimmedLineText(previousLine).length;
    if (totalChars > MAX_LINK_WINDOW_CHARS) {
      break;
    }
    startY -= 1;
  }

  totalChars = 0;
  for (let i = 0; i < MAX_LINK_WINDOW_LINES; i += 1) {
    const currentLine = buffer.getLine(endY);
    const nextLine = buffer.getLine(endY + 1);
    if (!currentLine || !nextLine || !shouldJoinNextLine(terminal, currentLine, nextLine)) {
      break;
    }

    totalChars += getTrimmedLineText(nextLine).length;
    if (totalChars > MAX_LINK_WINDOW_CHARS) {
      break;
    }
    endY += 1;
  }

  const segments: LogicalLineSegment[] = [];
  for (let bufferY = startY; bufferY <= endY; bufferY += 1) {
    const line = buffer.getLine(bufferY);
    if (line) {
      segments.push({ bufferY, text: getTrimmedLineText(line) });
    }
  }
  return segments;
}

function indexSegments(segments: LogicalLineSegment[]): IndexedSegment[] {
  let start = 0;
  return segments.map((segment) => {
    const indexed = {
      ...segment,
      start,
      end: start + segment.text.length,
    };
    start = indexed.end;
    return indexed;
  });
}

function positionForIndex(
  indexedSegments: IndexedSegment[],
  index: number,
  affinity: "start" | "end"
) {
  const last = indexedSegments[indexedSegments.length - 1];
  for (let segmentIndex = 0; segmentIndex < indexedSegments.length; segmentIndex += 1) {
    const segment = indexedSegments[segmentIndex];
    const isLast = segmentIndex === indexedSegments.length - 1;
    const isInsideSegment = affinity === "start" ? index < segment.end : index <= segment.end;
    if (isInsideSegment || isLast) {
      return {
        x: index - segment.start + 1,
        y: segment.bufferY + 1,
      };
    }
  }

  return {
    x: last.text.length + 1,
    y: last.bufferY + 1,
  };
}

export function findTerminalWebLinkMatches(
  terminal: TerminalLike,
  bufferLineNumber: number
): TerminalWebLinkMatch[] {
  const segments = getLogicalLineSegments(terminal, bufferLineNumber);
  if (segments.length === 0) {
    return [];
  }

  const indexedSegments = indexSegments(segments);
  const logicalText = segments.map((segment) => segment.text).join("");
  const matches: TerminalWebLinkMatch[] = [];

  for (const match of logicalText.matchAll(TERMINAL_URL_REGEX)) {
    const text = match[0];
    const index = match.index;
    if (index === undefined || !isValidHttpUrl(text)) {
      continue;
    }

    matches.push({
      text,
      range: {
        start: positionForIndex(indexedSegments, index, "start"),
        end: positionForIndex(indexedSegments, index + text.length, "end"),
      },
    });
  }

  return matches;
}
