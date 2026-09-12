/**
 * The per-tab settings the context menu changes.
 *
 * These used to be written straight into the store, which was fine while the
 * menu was desktop-only: the desktop owns the workspace document, so its own
 * edits stick. From a phone they did not. A replica's copy of the document is
 * a moment that has already moved on, and its local edit is overwritten by the
 * next snapshot from the desktop — the tick went on and came straight back
 * off, which looked like the menu doing nothing at all.
 *
 * So they travel the same way every other change a phone can make travels: as
 * an action the desktop performs. That means crossing a wire, and `undefined`
 * does not survive JSON — `null` is how this patch says "clear it".
 */

import type { TerminalSession } from "../types/terminal";

export interface TerminalSettingsPatch {
  isPinnedGreen?: boolean;
  isPinnedGray?: boolean;
  notifyOnInaction?: boolean;
  pushOnInaction?: boolean;
  bounceOnAttention?: boolean;
  /** Null wakes the tab. */
  snoozedUntil?: number | null;
  /** Null goes back to the app-wide default. */
  inactivityThresholdMs?: number | null;
}

/** Turn the wire form into what the store takes, where absent means absent. */
export function toSessionPatch(patch: TerminalSettingsPatch): Partial<TerminalSession> {
  const session: Partial<TerminalSession> = {};
  if (patch.isPinnedGreen !== undefined) {
    session.isPinnedGreen = patch.isPinnedGreen;
  }
  if (patch.isPinnedGray !== undefined) {
    session.isPinnedGray = patch.isPinnedGray;
  }
  if (patch.notifyOnInaction !== undefined) {
    session.notifyOnInaction = patch.notifyOnInaction;
  }
  if (patch.pushOnInaction !== undefined) {
    session.pushOnInaction = patch.pushOnInaction;
  }
  if (patch.bounceOnAttention !== undefined) {
    session.bounceOnAttention = patch.bounceOnAttention;
  }
  if (patch.snoozedUntil !== undefined) {
    session.snoozedUntil = patch.snoozedUntil ?? undefined;
  }
  if (patch.inactivityThresholdMs !== undefined) {
    session.inactivityThresholdMs = patch.inactivityThresholdMs ?? undefined;
  }
  return session;
}
