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
  notifyOnInaction?: boolean;
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
