/**
 * How long a tab may sit unchanged before it counts as inactive.
 *
 * The default is deliberately generous: ten seconds caught far too much of an
 * agent thinking, and an indicator that cries wolf stops being read. But one
 * number cannot fit every tab — a build is expected to be silent for minutes,
 * an agent going quiet for twenty seconds is waiting on you — so a tab may
 * override it.
 */
export const DEFAULT_INACTIVITY_THRESHOLD_MS = 20_000;

/**
 * Bounds on what a tab may be set to.
 *
 * Below the floor the indicator would fire between two frames of ordinary
 * output and mean nothing. The ceiling is not a judgement about long builds —
 * it is that a value this large is almost always a mistyped one, and a tab that
 * silently never reports again is a worse outcome than a rejected entry.
 */
export const MIN_INACTIVITY_THRESHOLD_MS = 5_000;
export const MAX_INACTIVITY_THRESHOLD_MS = 60 * 60 * 1000;

/**
 * The threshold to actually use for a tab.
 *
 * Anything unusable falls back to the default rather than propagating: this
 * value arrives from a text field and from replicated workspace state, so a
 * `NaN`, a negative, or an out-of-range number is reachable without anyone
 * having done something unreasonable. Silently sane beats a tab whose status
 * never updates again.
 */
export function resolveInactivityThresholdMs(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_INACTIVITY_THRESHOLD_MS;
  }
  if (value < MIN_INACTIVITY_THRESHOLD_MS || value > MAX_INACTIVITY_THRESHOLD_MS) {
    return DEFAULT_INACTIVITY_THRESHOLD_MS;
  }
  return Math.round(value);
}

/**
 * Turn what someone typed, in seconds, into a stored value.
 *
 * Returns null when the entry cannot be used, so the caller can keep the dialog
 * open rather than quietly storing something else. Clearing the field is a
 * distinct, valid intent — go back to the default — and is reported as
 * `undefined`.
 */
export function parseInactivityThresholdSeconds(
  input: string
): { ok: true; value: number | undefined } | { ok: false; reason: string } {
  const trimmed = input.trim();
  if (trimmed === "") {
    return { ok: true, value: undefined };
  }

  const seconds = Number(trimmed);
  if (!Number.isFinite(seconds)) {
    return { ok: false, reason: "Enter a number of seconds." };
  }

  const ms = Math.round(seconds * 1000);
  if (ms < MIN_INACTIVITY_THRESHOLD_MS) {
    return { ok: false, reason: `At least ${MIN_INACTIVITY_THRESHOLD_MS / 1000}s.` };
  }
  if (ms > MAX_INACTIVITY_THRESHOLD_MS) {
    return { ok: false, reason: `At most ${MAX_INACTIVITY_THRESHOLD_MS / 60_000} minutes.` };
  }
  return { ok: true, value: ms };
}

/** How the current setting reads in a menu. */
export function formatInactivityThreshold(value: number | undefined): string {
  const ms = resolveInactivityThresholdMs(value);
  if (ms % 60_000 === 0 && ms >= 60_000) {
    const minutes = ms / 60_000;
    return `${minutes}m`;
  }
  return `${Math.round(ms / 1000)}s`;
}
