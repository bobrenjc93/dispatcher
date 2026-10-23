import { multiplexerColourQueryAnswers, type ColourQueryAnswers } from "./backgroundColorQuery";

export const TMUX_CONTROL_START = "\u001bP1000p";
export const TMUX_CONTROL_END = "\u001b\\";

export const BRACKETED_PASTE_START = "\u001b[200~";
export const BRACKETED_PASTE_END = "\u001b[201~";

/**
 * Mark text as a paste rather than as typing.
 *
 * This is what xterm puts on the wire when something is pasted into it, and
 * the desktop recognises it on the way in and turns it back into a real tmux
 * paste. A replica that has to relay a paste with no xterm to do it -- a tab
 * switched to a moment ago has no mounted instance yet -- can say the same
 * thing by hand.
 */
export function wrapBracketedPaste(text: string): string {
  return `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`;
}
const TMUX_WINDOW_SNAPSHOT_FORMAT =
  '"#{window_id}\\t#{window_name}\\t#{window_active}\\t#{window_flags}\\t#{host}\\t#{socket_path}\\t#{session_id}\\t#{session_created}\\t#{version}\\t#{smux_version}"';
const TMUX_PANE_SNAPSHOT_FORMAT =
  '"#{window_id}\\t#{pane_id}\\t#{pane_left}\\t#{pane_top}\\t#{pane_width}\\t#{pane_height}\\t#{pane_active}\\t#{pane_current_path}\\t#{cursor_x}\\t#{cursor_y}\\t#{alternate_on}\\t#{history_size}"';
const TMUX_PANE_CURSOR_FORMAT = '"#{cursor_x}\\t#{cursor_y}"';
const TMUX_REPLICA_PANE_STATE_FORMAT =
  '"#{cursor_x}\\t#{cursor_y}\\t#{pane_height}\\t#{alternate_on}\\t#{cursor_flag}\\t#{keypad_cursor_flag}\\t#{keypad_flag}"';
const TMUX_CAPTURE_HISTORY_FALLBACK_LINES = 50_000;

export interface TmuxWindowSnapshot {
  windowId: string;
  title: string;
  isActive: boolean;
  flags: string;
  connectionKey?: string;
  /** Present when the server said what it is; see multiplexerColourQueryAnswers. */
  colourQueryAnswers?: ColourQueryAnswers;
}

export interface TmuxPaneSnapshot {
  windowId: string;
  paneId: string;
  left: number;
  top: number;
  width: number;
  height: number;
  isActive: boolean;
  cwd?: string;
  cursorX: number;
  cursorY: number;
  alternateOn: boolean;
  historySize: number;
}

export function buildTmuxWindowSnapshotCommand(targetWindowId?: string): string {
  return targetWindowId
    ? `display-message -p -t ${targetWindowId} ${TMUX_WINDOW_SNAPSHOT_FORMAT}`
    : `list-windows -F ${TMUX_WINDOW_SNAPSHOT_FORMAT}`;
}

export function buildTmuxPaneSnapshotCommand(options?: {
  targetWindowId?: string;
  allWindows?: boolean;
}): string {
  if (options?.targetWindowId) {
    return `list-panes -t ${options.targetWindowId} -F ${TMUX_PANE_SNAPSHOT_FORMAT}`;
  }

  if (options?.allWindows) {
    // -s scopes enumeration to every window in the attached session. -a is
    // server-wide and can mix panes from unrelated sessions into hydration.
    return `list-panes -s -F ${TMUX_PANE_SNAPSHOT_FORMAT}`;
  }

  return `list-panes -F ${TMUX_PANE_SNAPSHOT_FORMAT}`;
}

export function buildTmuxPaneCursorCommand(paneId: string): string {
  return `display-message -p -t ${paneId} ${TMUX_PANE_CURSOR_FORMAT}`;
}

export function buildTmuxPaneCaptureCommand(options: {
  paneId: string;
  alternateScreen?: boolean;
  includeHistory?: boolean;
  historySize?: number;
}): string {
  const flags = ["-p", "-e", "-C"];
  if (options.alternateScreen) {
    flags.push("-a", "-q");
  } else if (options.includeHistory !== false) {
    const historySize = options.historySize ?? TMUX_CAPTURE_HISTORY_FALLBACK_LINES;
    const boundedHistorySize = Math.max(0, Math.min(TMUX_CAPTURE_HISTORY_FALLBACK_LINES, Math.floor(historySize)));
    if (boundedHistorySize > 0) {
      flags.push("-S", `-${boundedHistorySize}`);
    }
  }
  return `capture-pane ${flags.join(" ")} -t ${options.paneId}`;
}

/**
 * What a replica needs besides the pane's text to draw it from blank: where
 * the cursor is, which screen it is on, and the modes a program set on its
 * way in. A replica's terminal is reset before a snapshot, so anything not
 * restored here is lost until the program happens to set it again — which
 * for a hidden cursor can be never.
 */
export interface TmuxReplicaPaneState {
  cursorX: number;
  cursorY: number;
  height: number;
  alternateOn: boolean;
  cursorVisible: boolean;
  applicationCursorKeys: boolean;
  applicationKeypad: boolean;
}

export function buildTmuxReplicaPaneStateCommand(paneId: string): string {
  return `display-message -p -t ${paneId} ${TMUX_REPLICA_PANE_STATE_FORMAT}`;
}

export function parseTmuxReplicaPaneState(line: string | undefined): TmuxReplicaPaneState | null {
  if (!line) {
    return null;
  }
  const [cursorX, cursorY, height, alternateOn, cursorFlag, keypadCursorFlag, keypadFlag] =
    line.split("\t");
  const parsedCursorX = Number.parseInt(cursorX ?? "", 10);
  const parsedCursorY = Number.parseInt(cursorY ?? "", 10);
  const parsedHeight = Number.parseInt(height ?? "", 10);
  if (![parsedCursorX, parsedCursorY, parsedHeight].every(Number.isFinite) || parsedHeight <= 0) {
    return null;
  }
  return {
    cursorX: Math.max(0, parsedCursorX),
    cursorY: Math.max(0, parsedCursorY),
    height: parsedHeight,
    alternateOn: alternateOn === "1",
    // An older tmux that does not know the flag expands it to nothing; a
    // visible cursor is the terminal's own default, so assume that.
    cursorVisible: cursorFlag !== "0",
    applicationCursorKeys: keypadCursorFlag === "1",
    applicationKeypad: keypadFlag === "1",
  };
}

/**
 * Draw a tmux pane from blank: its scrollback, then its screen, then the
 * cursor and modes.
 *
 * `lines` is a `capture-pane -p -e -C` reply whose last `height` lines are the
 * screen. When the whole thing will not fit in `maxBytes`, the oldest history
 * goes first; the screen is never cut, because it is the part the reader came
 * for.
 */
export function buildReplicaPaneReplay(options: {
  lines: readonly string[];
  state: TmuxReplicaPaneState | null;
  fallbackHeight: number;
  maxBytes: number;
}): string {
  const { lines, state } = options;
  const height = Math.min(lines.length, state?.height ?? options.fallbackHeight);
  const screenStart = lines.length - height;

  let historyStart = 0;
  let bytes = 0;
  for (const line of lines) {
    bytes += line.length + 2;
  }
  while (bytes > options.maxBytes && historyStart < screenStart) {
    bytes -= lines[historyStart].length + 2;
    historyStart += 1;
  }

  const content = unescapeTmuxOutput(lines.slice(historyStart).join("\r\n"));
  const cursorRow = (state?.cursorY ?? Math.max(0, height - 1)) + 1;
  const cursorCol = (state?.cursorX ?? 0) + 1;
  const screen = state?.alternateOn ? "\u001b[?1049h" : "";
  const modes = [
    state && !state.cursorVisible ? "\u001b[?25l" : "",
    state?.applicationCursorKeys ? "\u001b[?1h" : "",
    state?.applicationKeypad ? "\u001b=" : "",
  ].join("");
  // Autowrap is off while the lines go in, as for every tmux replay: each one
  // is already exactly as wide as the pane, and a wrap at the last column
  // would add a row that is not there.
  return `${screen}\u001b[0m\u001b[?7l\u001b[H\u001b[2J${content}\u001b[?7h\u001b[0m\u001b[${cursorRow};${cursorCol}H${modes}`;
}

export function buildTmuxNewWindowCommand(options: {
  targetWindowId: string;
  title?: string;
  inheritCurrentPanePath?: boolean;
}): string {
  const segments = ["new-window", "-a", "-t", options.targetWindowId];
  const trimmedTitle = options.title?.trim();
  if (trimmedTitle) {
    segments.push("-n", quoteTmuxCommandArgument(trimmedTitle));
  }
  if (options.inheritCurrentPanePath) {
    segments.push("-c", '"#{pane_current_path}"');
  }
  return segments.join(" ");
}

const tmuxOutputTextDecoder = new TextDecoder("utf-8", { fatal: false });
const tmuxOutputTextEncoder = new TextEncoder();

export function unescapeTmuxOutput(value: string): string {
  if (!value.includes("\\")) {
    return value;
  }

  // tmux octal escapes are raw bytes, not code points: multibyte UTF-8 text
  // arrives as one escape per byte (e.g. "é" as "\303\251"). Decode escapes
  // into a byte stream alongside the UTF-8 re-encoded literal characters and
  // convert the whole payload back to text in one pass, so escaped multibyte
  // sequences (including ones mixing raw and escaped bytes) are not mangled
  // into one Latin-1 character per byte.
  const parts: Uint8Array[] = [];
  let runStart = 0;

  const flushLiteralRun = (end: number) => {
    if (end > runStart) {
      parts.push(tmuxOutputTextEncoder.encode(value.slice(runStart, end)));
    }
  };

  const escapedBytes: number[] = [];
  const flushEscapedBytes = () => {
    if (escapedBytes.length > 0) {
      parts.push(Uint8Array.from(escapedBytes));
      escapedBytes.length = 0;
    }
  };

  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "\\") {
      continue;
    }

    // A literal backslash arrives in two encodings. `%output` octal-escapes it
    // as \134, but `capture-pane -C` doubles it instead, and both land here.
    // Left undecoded, the doubled form leaks a stray backslash into the pane —
    // visible on every OSC 8 hyperlink, whose `ESC \` terminator ends up as
    // `ESC \ \`. Two backslashes cannot occur in the octal-only encoding, so
    // decoding them is safe for `%output` too.
    if (value[index + 1] === "\\") {
      flushLiteralRun(index);
      escapedBytes.push(0x5c);
      flushEscapedBytes();
      index += 1;
      runStart = index + 1;
      continue;
    }

    if (index + 4 > value.length) {
      continue;
    }
    const octal = value.slice(index + 1, index + 4);
    if (!/^[0-7]{3}$/.test(octal)) {
      continue;
    }

    flushLiteralRun(index);
    escapedBytes.push(parseInt(octal, 8));
    index += 3;
    runStart = index + 1;
    // Coalesce adjacent escapes so multibyte sequences decode as one unit.
    while (
      runStart < value.length
      && value[runStart] === "\\"
      && /^[0-7]{3}$/.test(value.slice(runStart + 1, runStart + 4))
    ) {
      escapedBytes.push(parseInt(value.slice(runStart + 1, runStart + 4), 8));
      index += 4;
      runStart = index + 1;
    }
    flushEscapedBytes();
  }

  // No escape consumed: skip the encode/decode round trip (which would also
  // replace lone surrogates with U+FFFD) and return the input as-is.
  if (runStart === 0) {
    return value;
  }

  flushLiteralRun(value.length);

  if (parts.length === 1) {
    return tmuxOutputTextDecoder.decode(parts[0]);
  }

  let totalLength = 0;
  for (const part of parts) {
    totalLength += part.length;
  }
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.length;
  }
  return tmuxOutputTextDecoder.decode(merged);
}

export function encodeTmuxSendKeysHex(data: string, chunkSize: number = 64): string[] {
  const bytes = new TextEncoder().encode(data);
  const chunks: string[] = [];

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const slice = bytes.slice(offset, offset + chunkSize);
    chunks.push(Array.from(slice, (byte) => byte.toString(16).padStart(2, "0")).join(" "));
  }

  return chunks;
}

export function normalizeTmuxPasteBufferText(data: string): string {
  return data.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function parseTmuxWindowSnapshot(line: string): TmuxWindowSnapshot | null {
  const [
    windowId,
    title,
    activeFlag,
    flags = "",
    host = "",
    socketPath = "",
    sessionId = "",
    sessionCreated = "",
    version,
    smuxVersion = "",
  ] = line.split("\t");
  if (!windowId || title === undefined || activeFlag === undefined) {
    return null;
  }

  const connectionKey = host && socketPath && sessionId && sessionCreated
    ? JSON.stringify([host, socketPath, sessionId, sessionCreated])
    : undefined;

  return {
    windowId,
    title,
    isActive: activeFlag === "1",
    flags,
    ...(connectionKey ? { connectionKey } : {}),
    ...(version
      ? { colourQueryAnswers: multiplexerColourQueryAnswers({ version, smuxVersion, socketPath }) }
      : {}),
  };
}

export function selectTmuxWindowSnapshot(
  lines: readonly string[],
  targetWindowId?: string
): TmuxWindowSnapshot | null {
  const snapshots = lines
    .map(parseTmuxWindowSnapshot)
    .filter((value): value is TmuxWindowSnapshot => Boolean(value));

  if (targetWindowId) {
    return snapshots.find((snapshot) => snapshot.windowId === targetWindowId) ?? null;
  }

  return snapshots[0] ?? null;
}

export function parseTmuxPaneSnapshot(line: string): TmuxPaneSnapshot | null {
  const [
    windowId,
    paneId,
    left,
    top,
    width,
    height,
    activeFlag,
    cwd = "",
    cursorX = "0",
    cursorY = "0",
    alternateOn = "0",
    historySize = "0",
  ] = line.split("\t");
  if (!windowId || !paneId || left === undefined || top === undefined || width === undefined || height === undefined || activeFlag === undefined) {
    return null;
  }

  const parsedLeft = Number(left);
  const parsedTop = Number(top);
  const parsedWidth = Number(width);
  const parsedHeight = Number(height);
  const parsedCursorX = Number(cursorX);
  const parsedCursorY = Number(cursorY);
  const parsedHistorySize = Number(historySize);
  if (![parsedLeft, parsedTop, parsedWidth, parsedHeight, parsedCursorX, parsedCursorY, parsedHistorySize].every(Number.isFinite)) {
    return null;
  }

  return {
    windowId,
    paneId,
    left: parsedLeft,
    top: parsedTop,
    width: parsedWidth,
    height: parsedHeight,
    isActive: activeFlag === "1",
    cwd: cwd || undefined,
    cursorX: parsedCursorX,
    cursorY: parsedCursorY,
    alternateOn: alternateOn === "1",
    historySize: Math.max(0, Math.floor(parsedHistorySize)),
  };
}

export function quoteTmuxCommandArgument(value: string): string {
  let quoted = '"';
  for (const char of value) {
    switch (char) {
      case "\\":
        quoted += "\\\\";
        break;
      case '"':
        quoted += '\\"';
        break;
      case "$":
        quoted += "\\$";
        break;
      case "~":
        quoted += "\\~";
        break;
      case "\n":
        quoted += "\\n";
        break;
      case "\r":
        quoted += "\\r";
        break;
      case "\t":
        quoted += "\\t";
        break;
      case "\u001b":
        quoted += "\\e";
        break;
      default: {
        const code = char.charCodeAt(0);
        quoted += code < 32 || code === 127
          ? `\\${code.toString(8).padStart(3, "0")}`
          : char;
      }
    }
  }
  return `${quoted}"`;
}

/**
 * How soon to try a pane capture again after output raced it.
 *
 * Backing off exponentially is right for a pane nobody is looking at: it races
 * because it is busy, and hammering tmux for a background tab helps no one.
 *
 * It is wrong the moment someone is waiting. The attempt count belongs to the
 * pane and outlives any one attempt, so a tab that raced a few times in the
 * background arrives at your focus already near the ceiling — and the first
 * retry you actually wait for takes the full penalty. Focusing a tab and
 * staring at nothing for two and a half seconds is that arithmetic, not a slow
 * connection. Resizing the window looked like a fix because it forces an
 * immediate refresh and skips the queue entirely.
 *
 * A visible pane keeps a floor high enough not to spin — a capture round trip
 * is well under this — and no escalation beyond it.
 */
export const TMUX_CAPTURE_RETRY_BASE_MS = 300;
export const TMUX_CAPTURE_RETRY_MAX_MS = 2_500;
export const TMUX_VISIBLE_CAPTURE_RETRY_MAX_MS = 400;

export function computeCaptureRetryDelayMs(args: {
  attempts: number;
  paneIsVisible: boolean;
}): number {
  const exponent = Math.min(Math.max(0, args.attempts), 4);
  const backoff = TMUX_CAPTURE_RETRY_BASE_MS * 2 ** exponent;
  const ceiling = args.paneIsVisible
    ? TMUX_VISIBLE_CAPTURE_RETRY_MAX_MS
    : TMUX_CAPTURE_RETRY_MAX_MS;
  return Math.min(backoff, ceiling);
}
