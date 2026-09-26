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
  /**
   * Last time the tab produced anything at all, decoration included.
   *
   * Distinct from `effectiveChangedAt`, which only counts progress worth
   * looking at. A spinner is not progress, but it is proof the thing is still
   * running -- and a tab that is still running has not "possibly finished".
   */
  lastLivenessAt?: number;
  /**
   * When this run started watching, or 0 if that is not known.
   *
   * Acknowledgement lives in memory, so a reload resets it to zero for every
   * tab. A tab whose last output is days old then reads as "changed, and quiet
   * ever since" -- the exact shape of a finish -- and claims attention the
   * moment the monitor starts. Four tabs did that together twenty seconds
   * after one reload, none of which had run anything since the day before.
   *
   * Attention means this run watched a tab stop working. A change from before
   * it was watching was not witnessed and cannot be news.
   */
  watchingSince?: number;
  /**
   * Whether the tab has produced anything since the user last typed into it.
   *
   * Input counts as progress, which is right for keeping a tab green while you
   * work in it and wrong as grounds for interrupting you: with nothing but
   * your own keystroke to go on, a tab bounced at its user twenty-four seconds
   * after they typed into it, about the thing they had just typed.
   */
  hasOutputSinceUserInput?: boolean;
  wasNeedsAttention: boolean;
  wasPossiblyDone: boolean;
  wasLongInactive: boolean;
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
  shouldKeepLongInactiveUntilInput: boolean;
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
   * Green with attention border (needs attention):
   *   The tab was green, then became stale in the background, and the user has
   *   not acknowledged the current output generation yet.
   *
   * Brown (possibly done):
   *   The stale output has been acknowledged. The common path is "background tab
   *   needs attention, user focuses it, no real progress or user input follows."
   *   Focusing must not restart the stale timer; otherwise an attention tab waits a
   *   second full inactivity window before becoming brown.
   *
   * Gray (long inactive):
   *   The tab was brown, then remained unchanged for the long-inactivity window.
   *   Unacknowledged background work should keep needing attention instead of silently
   *   aging into gray, because gray means "you already looked at this stale
   *   output and it has been stale for a long time."
   */
  const changedForStatus = input.changed && !input.ignoreVisualChange;
  const isStable = input.hasDetectedActivity && !changedForStatus;
  const idleStartedAt = input.effectiveChangedAt;
  const staleStartedAt = input.effectiveChangedAt + input.inactivityMs;
  // Still making noise, even if none of it is worth reading. Going stale here
  // is what turned a working agent brown: its output was all decoration, the
  // progress clock stopped, and "no progress for a while" was read as "done".
  const aliveRecently =
    (input.lastLivenessAt ?? 0) > 0
    && input.now < (input.lastLivenessAt ?? 0) + input.inactivityMs;
  const hasReachedStaleThreshold = isStable && input.now >= staleStartedAt && !aliveRecently;
  // Older than this run's attention to it. Counted as already seen rather
  // than merely barred from attention: barring it alone would leave a tab
  // idle since yesterday sitting green, claiming to be at work. Seen-and-
  // stale is what it is, and it ages on to grey from there, which is where
  // the reload found it.
  const changePredatesWatching =
    (input.watchingSince ?? 0) > 0 && input.effectiveChangedAt < (input.watchingSince ?? 0);
  const hasAcknowledgedCurrentOutput =
    input.hasDetectedActivity &&
    (input.isActiveTab
      || input.acknowledgedTime >= input.effectiveChangedAt
      || changePredatesWatching);
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
    !hasAcknowledgedCurrentOutput &&
    // Nothing has happened that the user did not do themselves.
    (input.hasOutputSinceUserInput ?? true);
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
  const shouldKeepLongInactiveUntilInput = isStable && input.wasLongInactive;
  const shouldRevertToGreen = changedForStatus && !shouldKeepAttentionUntilFocus;
  const nextNeedsAttention = shouldKeepAttentionUntilFocus
    ? true
    : shouldRevertToGreen
      ? false
      : shouldKeepBrownUntilInput || shouldKeepLongInactiveUntilInput
        ? false
        : (isNeedsAttention && !isLongInactive);
  const nextPossiblyDone = shouldKeepLongInactiveUntilInput
    ? false
    : shouldKeepAttentionUntilFocus
      ? false
      : shouldRevertToGreen
        ? false
        : shouldKeepBrownUntilInput
          ? !isLongInactive
          : isPossiblyDone;
  const nextLongInactive = shouldKeepLongInactiveUntilInput
    ? true
    : nextNeedsAttention
      ? false
      : isLongInactive;

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
    shouldKeepLongInactiveUntilInput,
    nextNeedsAttention,
    nextPossiblyDone,
    nextLongInactive,
  };
}
