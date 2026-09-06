/**
 * Holding a tab quiet for a while.
 *
 * A tab that has just finished is the noisiest thing in the sidebar: it goes
 * brown, it asks for attention, and it chimes — all correct, and all useless
 * when you already know it is done and intend to come back to it later. The
 * existing answer was Pin Green, which never expires and so has to be
 * remembered and undone.
 *
 * Snoozing says the same thing with an end date. The tab reads as working, and
 * when the time is up it goes back to telling the truth on its own.
 */

export const DEFAULT_SNOOZE_MS = 5 * 60 * 1000;

/**
 * Whether a snooze is still running.
 *
 * Anything unusable reads as "not snoozed" rather than as an error: this value
 * arrives from replicated workspace state, and a tab stuck permanently green
 * because of a corrupt number is the one outcome worth ruling out.
 */
export function isSnoozeActive(snoozedUntil: number | undefined, now: number): boolean {
  return typeof snoozedUntil === "number" && Number.isFinite(snoozedUntil) && now < snoozedUntil;
}

/**
 * Turn what someone typed, in minutes, into a deadline.
 *
 * Returns null when the entry cannot be used, so the caller can keep the
 * dialog open rather than snoozing for a length nobody asked for. No upper
 * bound: a long snooze is a legitimate thing to want, and unlike a pin it
 * still ends.
 */
export function parseSnoozeMinutes(
  input: string,
  now: number
): { ok: true; until: number } | { ok: false; reason: string } {
  const minutes = Number(input.trim());
  if (!Number.isFinite(minutes)) {
    return { ok: false, reason: "Enter a number of minutes." };
  }
  if (minutes <= 0) {
    return { ok: false, reason: "Enter more than zero minutes." };
  }
  return { ok: true, until: now + Math.round(minutes * 60 * 1000) };
}

/** How much longer, for a menu row. Rounds up so it never reads "0m" while running. */
export function formatSnoozeRemaining(snoozedUntil: number, now: number): string {
  const remainingMs = Math.max(0, snoozedUntil - now);
  const minutes = Math.ceil(remainingMs / 60_000);
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
  }
  return `${minutes}m`;
}
