export type TerminalBackendKind =
  | "local"
  | "tmux-transport"
  | "tmux-window"
  | "tmux-pane";

export interface TerminalSession {
  id: string;
  title: string;
  notes: string;
  cwd?: string;
  hasDetectedActivity: boolean;
  lastUserInputAt: number;
  lastOutputAt: number;
  isNeedsAttention: boolean;
  isPossiblyDone: boolean;
  isLongInactive: boolean;
  isRecentlyFocused: boolean;
  isPinnedGreen?: boolean;
  isPinnedGray?: boolean;
  /**
   * Play a sound when this tab goes quiet. Shown as "Notify on Inactivity";
   * the stored name is left alone so existing settings survive.
   */
  notifyOnInaction?: boolean;
  /**
   * Bounce the dock icon when this tab starts needing attention. Shown as
   * "Bounce on Inactivity"; the stored name is left alone so existing settings
   * survive.
   */
  bounceOnAttention?: boolean;
  /**
   * How long this tab must sit unchanged before it counts as inactive, in
   * milliseconds. Unset means the app-wide default.
   *
   * Per tab because the right answer is a property of the work, not of the
   * user: a tab running a build is expected to be silent for minutes, while
   * one driving an agent going quiet for twenty seconds means it is waiting.
   * One global number makes one of those two noisy with false alarms.
   */
  inactivityThresholdMs?: number;
  backendKind: TerminalBackendKind;
  restoredFromBackendKind?: TerminalBackendKind;
  tmuxControlSessionId?: string;
  /**
   * Durable identity for the tmux server/session that owns this projection.
   * tmux window and pane IDs are only unique inside one server lifetime and
   * are routinely recycled (for example, several unrelated servers can all
   * have an `@1`). Keep this when a projection becomes a disconnected
   * placeholder so a later `tmux -CC attach` cannot adopt the wrong tab.
   */
  tmuxConnectionKey?: string;
  tmuxWindowId?: string;
  tmuxPaneId?: string;
}
