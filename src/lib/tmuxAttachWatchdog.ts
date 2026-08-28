/**
 * Notices when `tmux -CC` attaches and then says nothing.
 *
 * A healthy control-mode client emits its `\x1bP1000p%begin…` preamble within
 * milliseconds. A tmux server whose binary was replaced while it was running —
 * a package upgrade after the server started — never writes anything at all:
 * no preamble, no error, no exit. The tty is in raw mode by then, so Ctrl-C
 * does nothing either, and the tab just looks frozen.
 *
 * Traced on a live server, the sequence is: accept the connection, receive both
 * terminal descriptors over SCM_RIGHTS, receive the `attach` command — then
 * reach `control_start()` with both descriptors already lost, so it runs
 * `close(-1)` / `fcntl(-1)` and writes the preamble into a bufferevent on fd -1.
 * Commands keep working because they are answered over the socket and never
 * need those descriptors, which is why such a server looks healthy.
 *
 * That failure is otherwise invisible, and every occurrence strands a
 * control-mode client on the server and leaks two descriptors there. Saying so
 * immediately is the difference between a five-second diagnosis and a long one.
 */

import { debugLog } from "./debugLog";
import { recordSessionEvent } from "./sessionRecorder";

/** How long a control-mode client may stay silent before we call it stuck. */
const ATTACH_SILENCE_TIMEOUT_MS = 4_000;

/** Matches a submitted command line that starts tmux in control mode. */
const TMUX_CONTROL_COMMAND = /(^|[;&|]\s*)tmux\b[^;&|]*\s-[A-Za-z]*CC\b/;

/**
 * The shell echoes the newline right after Enter, so "any output" cannot mean
 * the attach is alive. A tmux that fails normally ("no sessions", a usage
 * error) prints far more than this before returning to a prompt.
 */
const QUIET_OUTPUT_BYTES = 64;

interface PendingAttach {
  terminalId: string;
  command: string;
  bytes: number;
  timer: ReturnType<typeof setTimeout>;
}

const pendingAttaches = new Map<string, PendingAttach>();
/** Input typed since the last newline, per terminal. */
const inputLines = new Map<string, string>();

type AttachStalledHandler = (terminalId: string, command: string) => void;

let onAttachStalled: AttachStalledHandler | null = null;

export function setAttachStalledHandler(handler: AttachStalledHandler | null) {
  onAttachStalled = handler;
}

function clearPending(terminalId: string) {
  const pending = pendingAttaches.get(terminalId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingAttaches.delete(terminalId);
  }
}

/**
 * Watch input for a `tmux -CC` invocation. Called for every keystroke, so it
 * only accumulates a line and tests it on submit.
 */
export function noteTerminalInput(terminalId: string, data: string) {
  if (!data) {
    return;
  }

  let line = inputLines.get(terminalId) ?? "";
  for (const char of data) {
    if (char === "\r" || char === "\n") {
      const submitted = line.trim();
      line = "";
      if (TMUX_CONTROL_COMMAND.test(submitted)) {
        armAttachWatchdog(terminalId, submitted);
      }
    } else if (char === "" || char === "\b") {
      line = line.slice(0, -1);
    } else if (char >= " ") {
      line += char;
    }
  }
  // Keep the buffer bounded; a command line long enough to matter is short.
  inputLines.set(terminalId, line.slice(-512));
}

export function armAttachWatchdog(terminalId: string, command: string) {
  clearPending(terminalId);

  const timer = setTimeout(() => {
    const pending = pendingAttaches.get(terminalId);
    pendingAttaches.delete(terminalId);
    if (!pending) {
      return;
    }

    // Output beyond the echo means tmux said something — an error, a usage
    // message, anything. That is a normal failure, not a stuck attach.
    if (pending.bytes > QUIET_OUTPUT_BYTES) {
      debugLog("tmux.attach", "attach produced output but no control mode", {
        terminalId,
        command,
        bytes: pending.bytes,
      });
      return;
    }

    debugLog("tmux.attach", "control-mode attach produced no output", {
      terminalId,
      command,
      bytes: pending.bytes,
      timeoutMs: ATTACH_SILENCE_TIMEOUT_MS,
    });
    recordSessionEvent("tmux-attach-stalled", { terminalId, command, bytes: pending.bytes });
    onAttachStalled?.(terminalId, command);
  }, ATTACH_SILENCE_TIMEOUT_MS);

  pendingAttaches.set(terminalId, { terminalId, command, bytes: 0, timer });
  debugLog("tmux.attach", "watching for control-mode preamble", {
    terminalId,
    command,
  });
}

/** The preamble arrived — the attach is healthy. */
export function noteControlModeStarted(terminalId: string) {
  if (pendingAttaches.has(terminalId)) {
    debugLog("tmux.attach", "control mode started", { terminalId });
    clearPending(terminalId);
  }
  inputLines.delete(terminalId);
}

/** Count output so the timeout can tell silence from a normal failure. */
export function noteTerminalOutput(terminalId: string, byteCount: number) {
  const pending = pendingAttaches.get(terminalId);
  if (pending) {
    pending.bytes += byteCount;
  }
}

export function disposeAttachWatchdog(terminalId: string) {
  clearPending(terminalId);
  inputLines.delete(terminalId);
}

export function isAttachPending(terminalId: string): boolean {
  return pendingAttaches.has(terminalId);
}
