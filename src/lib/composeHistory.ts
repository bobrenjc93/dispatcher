/**
 * What has been sent from the phone's compose box before.
 *
 * The shell keeps a history and the up arrow walks it, but nothing typed into
 * the compose box ever reaches a shell as keystrokes — it arrives as a paste,
 * already complete. So the shell has no memory of it, and on a phone that is
 * exactly the text worth having again: long prompts, typed with a thumb, often
 * a near-repeat of the last one.
 *
 * Kept across tabs rather than per terminal. The same prompt going to a
 * different tab is the common case here, and a per-tab history would hide the
 * entry you actually wanted behind the tab you happened to send it from.
 *
 * Desktop-local, like the closed-tab list: it is a convenience for one device,
 * not part of the workspace document.
 */

import { getScopedStorageKey } from "./storageNamespace";

/**
 * How many submissions to keep.
 *
 * Long enough to cover a working session of prompts, short enough that walking
 * back through it with two buttons stays a reasonable thing to do.
 */
export const COMPOSE_HISTORY_LIMIT = 50;

const STORAGE_KEY = getScopedStorageKey("dispatcher.composeHistory");

/** Newest first, which is the order the up button walks. */
export function loadComposeHistory(): string[] {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function write(entries: readonly string[]) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Losing the history costs the up button, not the send.
  }
}

/**
 * Record a submission, newest first.
 *
 * Re-sending the same text is normal — nudging an agent again, retrying a
 * command — and it should not push the rest of the history down a slot each
 * time, so an entry already present moves to the front instead of being added
 * beside itself.
 */
export function rememberComposedText(text: string): string[] {
  if (!text.trim()) {
    return loadComposeHistory();
  }
  const next = [text, ...loadComposeHistory().filter((entry) => entry !== text)]
    .slice(0, COMPOSE_HISTORY_LIMIT);
  write(next);
  return next;
}

export function clearComposeHistory() {
  write([]);
}

/**
 * Where in the history the box is currently showing from.
 *
 * `index` is -1 for the live draft, 0 for the most recent entry, and up from
 * there. `draft` is what had been typed before walking back, kept so coming
 * back down returns it rather than an empty box.
 */
export interface ComposeHistoryCursor {
  index: number;
  draft: string;
}

export const COMPOSE_HISTORY_START: ComposeHistoryCursor = { index: -1, draft: "" };

/**
 * Step one entry older or newer.
 *
 * Returns null when there is nowhere to go, so the caller can leave the box
 * alone rather than clearing it: reaching the end of the history and having
 * the text vanish would be its own bug.
 */
export function stepComposeHistory(args: {
  history: readonly string[];
  cursor: ComposeHistoryCursor;
  /** What is in the box right now, which may be an edited history entry. */
  current: string;
  direction: "older" | "newer";
}): { cursor: ComposeHistoryCursor; text: string } | null {
  const { history, cursor, current, direction } = args;

  if (direction === "older") {
    const nextIndex = cursor.index + 1;
    if (nextIndex >= history.length) {
      return null;
    }
    return {
      // Stepping off the draft is the only moment it can still be captured.
      cursor: { index: nextIndex, draft: cursor.index === -1 ? current : cursor.draft },
      text: history[nextIndex],
    };
  }

  if (cursor.index < 0) {
    return null;
  }
  const nextIndex = cursor.index - 1;
  return {
    cursor: { index: nextIndex, draft: cursor.draft },
    text: nextIndex === -1 ? cursor.draft : history[nextIndex],
  };
}
