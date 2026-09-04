/**
 * How long a tab may sit unchanged before it counts as inactive.
 *
 * The default is deliberately generous: ten seconds caught far too much of an
 * agent thinking, and an indicator that cries wolf stops being read. But one
 * number cannot fit every tab — a build is expected to be silent for minutes,
 * an agent going quiet for twenty seconds is waiting on you — so a tab may
 * override it, with no ceiling. A day-long threshold is a reasonable thing to
 * want for a tab watching something that reports once a day.
 */
export const DEFAULT_INACTIVITY_THRESHOLD_MS = 20_000;

/**
 * The threshold to actually use for a tab.
 *
 * The only values rejected are ones that are not a duration at all. This
 * arrives from replicated workspace state as well as from the dialog, so a
 * `NaN` or a negative is reachable without anyone having typed anything
 * strange, and a tab whose status silently never updates again is a worse
 * outcome than falling back to the default.
 */
export function resolveInactivityThresholdMs(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_INACTIVITY_THRESHOLD_MS;
  }
  return Math.round(value);
}

/**
 * Turn what someone typed, in seconds, into a stored value.
 *
 * Returns null when the entry cannot be used, so the caller can keep the
 * dialog open rather than quietly storing something else. Clearing the field
 * is a distinct, valid intent — go back to the default — and is reported as
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
  if (ms <= 0) {
    return { ok: false, reason: "Enter more than zero seconds." };
  }
  return { ok: true, value: ms };
}

/**
 * How the current setting reads in a menu.
 *
 * Two units at most: the menu row is narrow, and nobody setting a day-long
 * threshold cares about the trailing seconds.
 */
export function formatInactivityThreshold(value: number | undefined): string {
  const totalSeconds = Math.round(resolveInactivityThresholdMs(value) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }
  if (seconds > 0) {
    parts.push(`${seconds}s`);
  }
  return parts.slice(0, 2).join(" ") || "0s";
}
