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
  notifyOnInaction?: boolean;
  backendKind: TerminalBackendKind;
  restoredFromBackendKind?: TerminalBackendKind;
  tmuxControlSessionId?: string;
  tmuxWindowId?: string;
  tmuxPaneId?: string;
}
