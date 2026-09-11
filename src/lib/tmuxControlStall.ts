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
    "── Dispatcher: this pane's tmux control connection is gone ──",
    "[0m\r\n",
    "The ssh session ended, so commands are going to a shell instead.\r\n",
    `Re-attach with: ${attachHint}\r\n`,
  ].join("");
}
