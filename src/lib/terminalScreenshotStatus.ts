export interface TerminalScreenshotStatusInput {
  hasDetectedActivity: boolean;
  isActiveTab: boolean;
  changed: boolean;
  ignoreVisualChange?: boolean;
  now: number;
  effectiveChangedAt: number;
  acknowledgedTime: number;
  wasNeedsAttention: boolean;
  wasPossiblyDone: boolean;
  inactivityMs: number;
  longInactivityMs: number;
}

export interface TerminalScreenshotStatusState {
  hasAcknowledgedCurrentOutput: boolean;
  idleStartedAt: number;
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
  const changedForStatus = input.changed && !input.ignoreVisualChange;
  const hasAcknowledgedCurrentOutput =
    input.hasDetectedActivity && input.acknowledgedTime >= input.effectiveChangedAt;
  const idleStartedAt = hasAcknowledgedCurrentOutput
    ? Math.max(input.effectiveChangedAt, input.acknowledgedTime)
    : input.effectiveChangedAt;
  const isNeedsAttention =
    input.hasDetectedActivity &&
    !input.isActiveTab &&
    !changedForStatus &&
    !hasAcknowledgedCurrentOutput &&
    input.now - input.effectiveChangedAt >= input.inactivityMs;
  const isLongInactive =
    input.hasDetectedActivity &&
    !changedForStatus &&
    input.now - idleStartedAt >= input.longInactivityMs;
  const isPossiblyDone =
    input.hasDetectedActivity &&
    !changedForStatus &&
    !isNeedsAttention &&
    hasAcknowledgedCurrentOutput &&
    !isLongInactive &&
    input.now - idleStartedAt >= input.inactivityMs;
  const shouldKeepAttentionUntilFocus = !changedForStatus && input.wasNeedsAttention;
  const shouldKeepBrownUntilInput = !changedForStatus && input.wasPossiblyDone;
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
