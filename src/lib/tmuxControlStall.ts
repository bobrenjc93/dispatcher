/**
 * Noticing that nothing is speaking tmux control mode any more.
 *
 * When ssh drops, the remote `tmux -CC`/`smux -CC` dies with it and the PTY
 * falls back to the login shell. Dispatcher carries on writing control
 * commands into that shell, which answers `command not found: refresh-client`
 * and nothing else. The tab looks frozen: captures never arrive, keystrokes
 * join a queue that will never drain. One session sat like that for
 * thirty-four minutes with thirty-five commands queued.
 *
 * Two earlier attempts at this detector were reverted because they keyed on
 * "output that is not a control-mode line", which is also what an ordinary TUI
 * produces — they tore down sessions that were perfectly alive. The signals
 * here were chosen to be impossible to produce by accident:
 *
 *   - a shell error naming a command *we* sent, which an application's output
 *     cannot fabricate; and
 *   - commands outstanding with no reply at all for far longer than any round
 *     trip, when control mode answers every command.
 *
 * And the response is deliberately reversible: stop writing and say so. Any
 * control-mode byte clears it again, so a wrong guess costs a message rather
 * than a session.
 */

/** Commands Dispatcher sends, as a shell would name them in an error. */
const CONTROL_COMMAND_NAMES = [
  "refresh-client",
  "capture-pane",
  "display-message",
  "list-windows",
  "list-panes",
  "list-sessions",
  "send-keys",
  "select-window",
  "select-pane",
  "set-buffer",
  "paste-buffer",
  "kill-window",
  "kill-pane",
  "new-window",
  "split-window",
  "rename-window",
];

/**
 * A shell complaining about one of our commands.
 *
 * Matches the common shells: zsh's `zsh: command not found: refresh-client`,
 * bash's `bash: refresh-client: command not found`, and the bare forms.
 */
export function isShellRejectingControlCommand(line: string): boolean {
  if (!line.includes("command not found") && !line.includes("not found")) {
    return false;
  }
  return CONTROL_COMMAND_NAMES.some((name) => line.includes(name));
}

/**
 * How long a command may go unanswered before the far end is not listening.
 *
 * Control mode replies to everything, and it replies immediately — the round
 * trip is an ssh hop. A minute is far past any of that, and well past the
 * pauses a loaded host produces.
 */
export const TMUX_CONTROL_STALL_MS = 60_000;

export function hasControlStreamStalled(args: {
  pendingCommandCount: number;
  oldestPendingSentAt: number | null;
  now: number;
  stallMs?: number;
}): boolean {
  if (args.pendingCommandCount === 0 || args.oldestPendingSentAt === null) {
    return false;
  }
  return args.now - args.oldestPendingSentAt >= (args.stallMs ?? TMUX_CONTROL_STALL_MS);
}

/** What to show in a pane whose control stream has gone. */
export function buildControlStreamStalledNotice(attachHint: string): string {
  return [
    "\r\n",
    "[33m",
    "── Dispatcher: this pane's tmux control connection is not answering ──",
    "[0m\r\n",
    "Either the connection is stuck or the ssh session ended. Typing here is not\r\n",
    "being sent; this clears by itself if the connection comes back.\r\n",
    `If it does not, re-attach with: ${attachHint}\r\n`,
  ].join("");
}

/**
 * How long a command may go without a single byte back before typing is held.
 *
 * Far shorter than the stall verdict, because it costs far less to be wrong:
 * a keystroke is not sent and the pane says so, and nothing is abandoned.
 * Being late costs a great deal more. Keystrokes written into a connection
 * that has stopped moving are not lost -- they wait in the pipe, and arrive
 * all together the moment it opens. Two Ctrl-Cs typed ten seconds apart into
 * a frozen tab reached Claude Code back to back, which is its gesture for
 * exit, and the session it had been running for hours closed.
 *
 * Control mode answers every command at once, so five seconds with nothing at
 * all coming back -- not even the output of some other pane -- is not a slow
 * host.
 */
export const TMUX_INPUT_HOLD_MS = 5_000;

/** Whether the connection has gone quiet with a command still waiting on it. */
export function isControlStreamQuiet(args: {
  oldestPendingSentAt: number | null;
  lastTrafficAt: number;
  now: number;
  holdMs?: number;
}): boolean {
  if (args.oldestPendingSentAt === null) {
    return false;
  }
  return args.lastTrafficAt <= args.oldestPendingSentAt
    && args.now - args.oldestPendingSentAt >= (args.holdMs ?? TMUX_INPUT_HOLD_MS);
}

/**
 * How long a connection may be silent before Dispatcher asks it something.
 *
 * Silence is normal -- idle panes print nothing -- and silence is also what a
 * frozen connection looks like, so the only way to tell them apart is to ask.
 * Without this nothing was asked until the user came back and typed: a link
 * frozen for eighty minutes was noticed a minute after they started, and
 * everything typed in that minute arrived late.
 */
export const TMUX_HEARTBEAT_IDLE_MS = 15_000;

/** Whether to ask a silent connection whether it is still there. */
export function shouldSendHeartbeat(args: {
  pendingCommandCount: number;
  lastTrafficAt: number;
  now: number;
  idleMs?: number;
}): boolean {
  return args.pendingCommandCount === 0
    && args.now - args.lastTrafficAt >= (args.idleMs ?? TMUX_HEARTBEAT_IDLE_MS);
}

/** What to show in a pane when its typing was held back. */
export function buildInputHeldNotice(quietForMs: number): string {
  const seconds = Math.max(1, Math.round(quietForMs / 1000));
  return [
    "\r\n",
    "[33m",
    `── Dispatcher: no reply from this pane's connection for ${seconds}s ──`,
    "[0m\r\n",
    "Typing is not being sent, so it cannot all arrive at once later.\r\n",
    "Type again once the connection answers.\r\n",
  ].join("");
}

/**
 * How long the answers to abandoned commands are still expected.
 *
 * tmux does not stop working on a command because Dispatcher stopped waiting,
 * so those replies are still owed and must be counted off rather than handed
 * to whatever is next in the queue. A machine asleep for three and a half
 * minutes came back to eighty-eight of them delivered in a single breath,
 * which is how backlogs arrive: all at once, the moment the pipe opens.
 *
 * Generous against that, and short enough that a debt from a connection that
 * really died is written off long before it can starve a live command.
 */
export const TMUX_OWED_REPLY_WINDOW_MS = 30_000;
