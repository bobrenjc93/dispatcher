/**
 * localStorage that does not write on every keystroke of state.
 *
 * zustand's persist writes the whole partialized slice on every `set`, and the
 * terminal store is set from the output path: every batch of bytes from every
 * pane marks activity, which rewrites the entire sessions map. With a screen
 * of busy agents that is tens of writes a second, each one tens of kilobytes.
 *
 * localStorage being synchronous makes that a main-thread cost, but the real
 * damage is underneath it. WebKit keeps localStorage in SQLite, and every
 * write appends to a write-ahead log that is only folded back into the
 * database on a checkpoint. Sustained writes plus restarts that never
 * checkpoint cleanly grow that log without bound: one was found at 67 GiB,
 * having filled the disk, next to a 135 KB database.
 *
 * So writes are coalesced. The last value for a key within the window is the
 * one that lands, which is exactly right for a snapshot — nothing cares about
 * the intermediate states, only the current one.
 *
 * Reads come from the pending value first, so a read-after-write sees what was
 * written rather than the last value to reach disk.
 */

import { createJSONStorage, type StateStorage } from "zustand/middleware";

/**
 * How long to hold a write.
 *
 * Long enough to collapse a burst of output into one write, short enough that
 * a hard kill loses at most a second of bookkeeping — and the things that
 * would be lost (last-output timestamps, activity flags) are re-derived from
 * the panes on the way back up anyway.
 */
export const PERSIST_THROTTLE_MS = 1_000;

export function createThrottledStateStorage(
  delayMs: number = PERSIST_THROTTLE_MS
): StateStorage {
  const pending = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending.size === 0) {
      return;
    }
    for (const [key, value] of pending) {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        // Out of quota, or no storage at all. Losing the snapshot is survivable
        // and there is nobody to tell.
      }
    }
    pending.clear();
  };

  if (typeof window !== "undefined") {
    // Quitting has to write, or the throttle turns into data loss. pagehide is
    // the one that fires reliably on iOS, where the app is suspended rather
    // than closed; visibilitychange covers being backgrounded before that.
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        flush();
      }
    });
  }

  return {
    getItem: (name) => {
      const held = pending.get(name);
      if (held !== undefined) {
        return held;
      }
      try {
        return window.localStorage.getItem(name);
      } catch {
        return null;
      }
    },
    setItem: (name, value) => {
      pending.set(name, value);
      if (timer === null) {
        timer = setTimeout(flush, delayMs);
      }
    },
    removeItem: (name) => {
      pending.delete(name);
      try {
        window.localStorage.removeItem(name);
      } catch {
        // Nothing to do about it.
      }
    },
  };
}

/** Shared across stores so one timer covers all of them. */
const throttledStateStorage = createThrottledStateStorage();

/** Drop-in for persist's `storage` option. */
export const throttledJSONStorage = createJSONStorage(() => throttledStateStorage);
