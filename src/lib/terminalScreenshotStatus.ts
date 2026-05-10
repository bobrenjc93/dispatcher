export interface TerminalScreenshotStatusInput {
  /** At least one terminal in the tab has ever produced user input or output. */
  hasDetectedActivity: boolean;
  /** The user can currently see this tab; active tabs count as acknowledged. */
  isActiveTab: boolean;
  /** The latest visual/timestamp sample showed real progress for this tab. */
  changed: boolean;
  /** Tmux focus/resize redraws may visually change without meaning agent progress. */
  ignoreVisualChange?: boolean;
  now: number;
  /** Most recent accepted progress time: visual change, terminal output, or user input. */
  effectiveChangedAt: number;
  /** Last time the user focused this tab after the current output generation existed. */
  acknowledgedTime: number;
  wasNeedsAttention: boolean;
  wasPossiblyDone: boolean;
  inactivityMs: number;
  longInactivityMs: number;
}

export interface TerminalScreenshotStatusState {
  hasAcknowledgedCurrentOutput: boolean;
  /** The time from which "no accepted progress" is measured. */
  idleStartedAt: number;
  /** The time at which a stable green tab first becomes stale. */
  staleStartedAt: number;
  /** The time at which stale output became acknowledged brown, if it has. */
  brownStartedAt: number | null;
  isNeedsAttention: boolean;
  isPossiblyDone: boolean;
  isLongInactive: boolean;
  changedForStatus: boolean;
  shouldKeepAttentionUntilFocus: boolean;
  shouldKeepBrownUntilInput: boolean;
  nextNeedsAttention: boolean;
  nextPossiblyDone: boolean;
  nextLongInactive: boolean;
}

export function resolveTerminalScreenshotStatus(
  input: TerminalScreenshotStatusInput
): TerminalScreenshotStatusState {
  /*
   * Status dot state machine
   * ------------------------
   * Green:
   *   The tab is still within the inactivity window, or we just saw accepted
   *   progress. In product terms this means "the agent appears to be working."
   *
   * Pulsing green (needs attention):
   *   The tab was green, then became stale in the background, and the user has
   *   not acknowledged the current output generation yet.
   *
   * Brown (possibly done):
   *   The stale output has been acknowledged. The common path is "background tab
   *   starts pulsing, user focuses it, no real progress or user input follows."
   *   Focusing must not restart the stale timer; otherwise a pulsing tab waits a
   *   second full inactivity window before becoming brown.
   *
   * Gray (long inactive):
   *   The tab was brown, then remained unchanged for the long-inactivity window.
   *   Unacknowledged background work should keep pulsing instead of silently
   *   aging into gray, because gray means "you already looked at this stale
   *   output and it has been stale for a long time."
   */
  const changedForStatus = input.changed && !input.ignoreVisualChange;
  const isStable = input.hasDetectedActivity && !changedForStatus;
  const idleStartedAt = input.effectiveChangedAt;
  const staleStartedAt = input.effectiveChangedAt + input.inactivityMs;
  const hasReachedStaleThreshold = isStable && input.now >= staleStartedAt;
  const hasAcknowledgedCurrentOutput =
    input.hasDetectedActivity &&
    (input.isActiveTab || input.acknowledgedTime >= input.effectiveChangedAt);
  const acknowledgedCurrentOutputAt =
    input.acknowledgedTime >= input.effectiveChangedAt
      ? input.acknowledgedTime
      : 0;
  const brownStartedAt =
    hasReachedStaleThreshold && hasAcknowledgedCurrentOutput
      ? Math.max(staleStartedAt, acknowledgedCurrentOutputAt || staleStartedAt)
      : null;
  const isNeedsAttention =
    hasReachedStaleThreshold &&
    !input.isActiveTab &&
    !hasAcknowledgedCurrentOutput;
  const isLongInactive =
    brownStartedAt !== null &&
    input.now - brownStartedAt >= input.longInactivityMs;
  const isPossiblyDone =
    hasReachedStaleThreshold &&
    !isNeedsAttention &&
    hasAcknowledgedCurrentOutput &&
    !isLongInactive;
  const shouldKeepAttentionUntilFocus =
    isStable && input.wasNeedsAttention && !hasAcknowledgedCurrentOutput;
  const shouldKeepBrownUntilInput = isStable && input.wasPossiblyDone;
  const shouldRevertToGreen = changedForStatus && !shouldKeepAttentionUntilFocus;
  const nextNeedsAttention = shouldKeepAttentionUntilFocus
    ? true
    : shouldRevertToGreen
      ? false
      : shouldKeepBrownUntilInput
        ? false
        : (isNeedsAttention && !isLongInactive);
  const nextPossiblyDone = shouldKeepAttentionUntilFocus
    ? false
    : shouldRevertToGreen
      ? false
      : shouldKeepBrownUntilInput
        ? !isLongInactive
        : isPossiblyDone;
  const nextLongInactive = nextNeedsAttention ? false : isLongInactive;

  return {
    hasAcknowledgedCurrentOutput,
    idleStartedAt,
    staleStartedAt,
    brownStartedAt,
    isNeedsAttention,
    isPossiblyDone,
    isLongInactive,
    changedForStatus,
    shouldKeepAttentionUntilFocus,
    shouldKeepBrownUntilInput,
    nextNeedsAttention,
    nextPossiblyDone,
    nextLongInactive,
  };
}
