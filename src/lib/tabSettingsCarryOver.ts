import type { TerminalSession } from "../types/terminal";

/**
 * What a user has set on a tab, as opposed to what Dispatcher works out.
 *
 * The title is not here: a tmux tab's title is its window's name, which lives
 * on the server and comes back with the window.
 */
const TAB_SETTING_KEYS = [
  "notes",
  "isPinnedGreen",
  "isPinnedGray",
  "snoozedUntil",
  "notifyOnInaction",
  "bounceOnAttention",
  "pushOnInaction",
  "inactivityThresholdMs",
  "inactivityChangePercent",
] as const satisfies readonly (keyof TerminalSession)[];

function isUnset(value: unknown): boolean {
  return value === undefined || value === null || value === false || value === "";
}

/**
 * The settings to give a tab that is replacing another copy of the same thing.
 *
 * Two tabs for one tmux window happen when a server is re-attached while the
 * tabs from the old connection are still around; one of them is then removed
 * as a duplicate. Whichever copy goes, what the user set on it must not go
 * with it: removing the older copy took its green pin, its notes and its
 * inactivity settings, and a dozen pinned tabs came back plain.
 *
 * Only fills what the kept tab has left unset, so nothing set on the copy
 * being kept is overwritten.
 */
export function carryOverTabSettings(
  from: TerminalSession,
  to: TerminalSession
): Partial<TerminalSession> {
  const patch: Partial<TerminalSession> = {};
  for (const key of TAB_SETTING_KEYS) {
    if (isUnset(to[key]) && !isUnset(from[key])) {
      (patch as Record<string, unknown>)[key] = from[key];
    }
  }
  // The two pins are exclusive; never end up with both.
  if (patch.isPinnedGreen && to.isPinnedGray) {
    delete patch.isPinnedGreen;
  }
  if (patch.isPinnedGray && to.isPinnedGreen) {
    delete patch.isPinnedGray;
  }
  return patch;
}
