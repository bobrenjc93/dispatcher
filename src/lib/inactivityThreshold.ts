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

/**
 * How much of the screen has to change for output to count as the tab at work.
 *
 * Unset is the usual answer, and means the built-in rule: a handful of rows
 * and characters, measured against the spinners and clocks that kept waking
 * idle tabs. Set, it replaces that rule with one number the user picked --
 * "below 5% for a minute is inactive" -- and output under it stops keeping
 * the tab alive as well, because otherwise a spinner would hold it green
 * forever and the setting would never take effect.
 *
 * A percentage of the screen's cells, so it means the same thing on a phone-
 * sized pane as on a full-width one.
 */
export function resolveInactivityChangePercent(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 100) {
    return undefined;
  }
  return value;
}

/**
 * Turn what someone typed, in percent, into a stored value.
 *
 * A trailing `%` is accepted, since that is how the number is written. Empty
 * means the built-in rule.
 */
export function parseInactivityChangePercent(
  input: string
): { ok: true; value: number | undefined } | { ok: false; reason: string } {
  const trimmed = input.trim().replace(/%$/, "").trim();
  if (trimmed === "") {
    return { ok: true, value: undefined };
  }

  const percent = Number(trimmed);
  if (!Number.isFinite(percent)) {
    return { ok: false, reason: "Enter a percentage of the screen." };
  }
  if (percent <= 0 || percent > 100) {
    return { ok: false, reason: "Enter a percentage above 0 and at most 100." };
  }
  return { ok: true, value: percent };
}

/** A percentage as people write one: no trailing zeros, and small ones kept. */
export function formatInactivityChangePercent(value: number): string {
  const digits = value >= 10 ? 0 : value >= 1 ? 1 : 2;
  return `${Number(value.toFixed(digits))}%`;
}

/** Both halves of the setting, for the menu's narrow right-hand column. */
export function formatInactivitySetting(
  thresholdMs: number | undefined,
  changePercent: number | undefined
): string {
  const duration = formatInactivityThreshold(thresholdMs);
  const percent = resolveInactivityChangePercent(changePercent);
  return percent === undefined ? duration : `${duration} < ${formatInactivityChangePercent(percent)}`;
}
