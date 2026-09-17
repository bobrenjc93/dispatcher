/**
 * A program saying, in so many words, that it wants you.
 *
 * Dispatcher decides a tab needs attention by watching it go quiet, which is a
 * guess and a poor one for an agent: pausing to think, or waiting on a tool
 * call that takes two minutes, looks exactly like being finished. Six of eight
 * such notifications in one afternoon were followed by the tab carrying on
 * within seconds of the push landing.
 *
 * Meanwhile the program states it outright. Claude Code emits OSC 9 -- the
 * desktop-notification escape -- with "Claude is waiting for your input", and
 * that marker was sitting unread in the stream of the very panes that cried
 * wolf. Silence is an inference; this is the answer.
 *
 * Kept as a fallback rather than a replacement: `make` does not announce
 * itself, and a tab running one still has nothing but quiet to go on.
 */

/**
 * OSC 9, in both the terminators the spec allows.
 *
 * `\x1b]9;<text>` closed by BEL or ST. Non-greedy, so two markers in one chunk
 * are two matches rather than one spanning both.
 */
const ATTENTION_MARKER_PATTERN = /\x1b\]9;([\s\S]*?)(?:\x07|\x1b\\)/g;

/**
 * ConEmu's progress reports share the OSC 9 number.
 *
 * `\x1b]9;4;1;50\x07` is "50% done", which is the opposite of wanting
 * attention -- it is a program getting on with it. Only the plain message form
 * is a notification.
 */
function isProgressReport(body: string): boolean {
  return /^4(;|$)/.test(body);
}

/** Every attention message in a chunk of pane output, in order. */
export function findAttentionMarkers(data: string): string[] {
  if (!data.includes("]9;")) {
    return [];
  }
  const found: string[] = [];
  ATTENTION_MARKER_PATTERN.lastIndex = 0;
  let match = ATTENTION_MARKER_PATTERN.exec(data);
  while (match !== null) {
    const body = match[1];
    if (body.length > 0 && !isProgressReport(body)) {
      found.push(body);
    }
    match = ATTENTION_MARKER_PATTERN.exec(data);
  }
  ATTENTION_MARKER_PATTERN.lastIndex = 0;
  return found;
}

/** Whether a chunk contains any. */
export function hasAttentionMarker(data: string): boolean {
  return findAttentionMarkers(data).length > 0;
}

/**
 * Markers seen but not yet acted on, by tab.
 *
 * Recorded where the output is decoded and read where notifications are
 * decided, which are far apart and have no reason to know about each other.
 * Keyed on the tab root, because that is what a notification is about -- a
 * split tab with two panes is still one thing to be told about.
 */
const requestedAt = new Map<string, number>();

export function noteAttentionRequested(tabRootTerminalId: string, at: number = Date.now()) {
  requestedAt.set(tabRootTerminalId, at);
}

/** The pending request, if it is newer than the last one acted on. */
export function peekAttentionRequest(tabRootTerminalId: string, since: number): number | null {
  const at = requestedAt.get(tabRootTerminalId);
  return at !== undefined && at > since ? at : null;
}

export function clearAttentionRequest(tabRootTerminalId: string) {
  requestedAt.delete(tabRootTerminalId);
}

/** Test seam. */
export function resetAttentionRequests() {
  requestedAt.clear();
}
