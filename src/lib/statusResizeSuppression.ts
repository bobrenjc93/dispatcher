export const STATUS_RESIZE_SUPPRESSION_MS = 5_000;
// Keep expired resize windows around long enough for the status sampler to see
// that a recently-recorded output timestamp landed inside a resize. The sampler
// runs on a 5s interval, so deleting the marker exactly at `until` creates a
// race where resize output recorded near the end of the window becomes a normal
// activity baseline on the next tick.
export const STATUS_RESIZE_SUPPRESSION_RETENTION_MS = 60_000;

export interface StatusResizeSuppression {
  terminalId: string;
  startedAt: number;
  until: number;
  reason: string;
}

interface StatusResizeSuppressionRuntime {
  suppressions: Map<string, StatusResizeSuppression>;
}

declare global {
  // eslint-disable-next-line no-var
  var __dispatcherStatusResizeSuppressionRuntime: StatusResizeSuppressionRuntime | undefined;
}

function getRuntime(): StatusResizeSuppressionRuntime {
  if (globalThis.__dispatcherStatusResizeSuppressionRuntime) {
    globalThis.__dispatcherStatusResizeSuppressionRuntime.suppressions ??= new Map();
    return globalThis.__dispatcherStatusResizeSuppressionRuntime;
  }

  const created: StatusResizeSuppressionRuntime = {
    suppressions: new Map(),
  };
  globalThis.__dispatcherStatusResizeSuppressionRuntime = created;
  return created;
}

function normalizeTerminalIds(terminalIds: Iterable<string | null | undefined>): string[] {
  return [...new Set([...terminalIds].filter((terminalId): terminalId is string => Boolean(terminalId)))];
}

export function markStatusResizeSuppression(
  terminalIds: Iterable<string | null | undefined>,
  reason: string,
  now: number = Date.now(),
  durationMs: number = STATUS_RESIZE_SUPPRESSION_MS
) {
  const normalizedTerminalIds = normalizeTerminalIds(terminalIds);
  if (normalizedTerminalIds.length === 0) {
    return;
  }

  const runtime = getRuntime();
  const nextUntil = now + Math.max(0, durationMs);
  for (const terminalId of normalizedTerminalIds) {
    const existing = runtime.suppressions.get(terminalId);
    if (existing && existing.until >= nextUntil) {
      continue;
    }
    runtime.suppressions.set(terminalId, {
      terminalId,
      startedAt: now,
      until: nextUntil,
      reason,
    });
  }
}

export function getActiveStatusResizeSuppression(
  terminalIds: Iterable<string | null | undefined>,
  now: number = Date.now()
): StatusResizeSuppression | null {
  const runtime = getRuntime();
  let active: StatusResizeSuppression | null = null;

  for (const terminalId of normalizeTerminalIds(terminalIds)) {
    const suppression = runtime.suppressions.get(terminalId);
    if (!suppression) {
      continue;
    }
    if (now > suppression.until) {
      if (now > suppression.until + STATUS_RESIZE_SUPPRESSION_RETENTION_MS) {
        runtime.suppressions.delete(terminalId);
      }
      continue;
    }
    if (!active || suppression.until > active.until) {
      active = suppression;
    }
  }

  return active;
}

export function getStatusResizeSuppressionForActivity(
  terminalIds: Iterable<string | null | undefined>,
  activityAt: number,
  now: number = Date.now()
): StatusResizeSuppression | null {
  if (activityAt <= 0) {
    return null;
  }

  const runtime = getRuntime();
  let matching: StatusResizeSuppression | null = null;

  for (const terminalId of normalizeTerminalIds(terminalIds)) {
    const suppression = runtime.suppressions.get(terminalId);
    if (!suppression) {
      continue;
    }
    if (now > suppression.until + STATUS_RESIZE_SUPPRESSION_RETENTION_MS) {
      runtime.suppressions.delete(terminalId);
      continue;
    }
    if (activityAt < suppression.startedAt || activityAt > suppression.until) {
      continue;
    }
    if (!matching || suppression.until > matching.until) {
      matching = suppression;
    }
  }

  return matching;
}

export function shouldIgnoreStatusResizeChange(args: {
  changed: boolean;
  suppression: StatusResizeSuppression | null;
  lastUserInputAt: number;
  lastOutputAt: number;
}): boolean {
  return (
    args.changed
    && args.suppression !== null
    && args.lastUserInputAt <= args.suppression.startedAt
    && args.lastOutputAt <= args.suppression.until
  );
}

export function clearStatusResizeSuppressionsForTests() {
  getRuntime().suppressions.clear();
}
