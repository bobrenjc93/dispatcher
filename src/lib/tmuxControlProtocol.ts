export const TMUX_CONTROL_START = "\u001bP1000p";
export const TMUX_CONTROL_END = "\u001b\\";
const TMUX_WINDOW_SNAPSHOT_FORMAT =
  '"#{window_id}\\t#{window_name}\\t#{window_active}\\t#{window_flags}\\t#{host}\\t#{socket_path}\\t#{session_id}\\t#{session_created}"';
const TMUX_PANE_SNAPSHOT_FORMAT =
  '"#{window_id}\\t#{pane_id}\\t#{pane_left}\\t#{pane_top}\\t#{pane_width}\\t#{pane_height}\\t#{pane_active}\\t#{pane_current_path}\\t#{cursor_x}\\t#{cursor_y}\\t#{alternate_on}\\t#{history_size}"';
const TMUX_PANE_CURSOR_FORMAT = '"#{cursor_x}\\t#{cursor_y}"';
const TMUX_CAPTURE_HISTORY_FALLBACK_LINES = 50_000;

export interface TmuxWindowSnapshot {
  windowId: string;
  title: string;
  isActive: boolean;
  flags: string;
  connectionKey?: string;
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
 * How many protocol-less lines in a row mean the far end has stopped speaking
 * control mode.
 *
 * When ssh dies under a `tmux -CC` session the PTY survives and falls back to a
 * local shell, which answers the commands still being sent to it with things
 * like `zsh: command not found: refresh-client`. tmux sends no `%exit` in that
 * case — there is no tmux left to send one — so the only evidence is the shape
 * of what comes back.
 *
 * Any line beginning with `%` resets the run, which is what makes this safe: a
 * live session emits `%output` constantly, so a healthy stream cannot
 * accumulate a run at all. The threshold is set well above the stray line, and
 * a dead session clears it within a second because every queued command draws
 * a prompt and an error.
 */
export const TMUX_LOST_CONTROL_STREAM_LINES = 10;

/** The run length after `line`, given the run before it. */
export function nextUnscopedLineRun(currentRun: number, line: string): number {
  return line.startsWith("%") ? 0 : currentRun + 1;
}

export function hasLostControlStream(unscopedLineRun: number): boolean {
  return unscopedLineRun >= TMUX_LOST_CONTROL_STREAM_LINES;
}

/**
 * How long a control session may owe us a reply before it counts as gone.
 *
 * The other way a `tmux -CC` session dies: ssh does not error and the shell
 * never surfaces, the connection simply stops carrying bytes. Nothing arrives
 * at all — no `%exit`, no shell chatter, so there is no line to inspect and
 * {@link hasLostControlStream} is blind to it. What is observable is the
 * silence itself, but only while something is outstanding: an idle session is
 * legitimately silent for hours, and a session owing a reply is not.
 *
 * tmux answers `%begin` at network latency, so any real reply beats this by
 * three orders of magnitude. The margin is for a slow link, not a slow tmux.
 */
export const TMUX_COMMAND_SILENCE_TIMEOUT_MS = 30_000;

export function hasLostControlStreamToSilence(args: {
  outstandingCommands: number;
  msSinceLastLine: number;
}): boolean {
  return (
    args.outstandingCommands > 0
    && args.msSinceLastLine >= TMUX_COMMAND_SILENCE_TIMEOUT_MS
  );
}
