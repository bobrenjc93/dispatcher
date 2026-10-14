/**
 * What a tab's activity judgment has seen lately, kept to be looked at.
 *
 * A tab goes inactive when its screen stops changing enough for long enough,
 * and both halves of that are settings. Choosing them blind is guesswork:
 * nobody knows offhand whether their agent's spinner moves 0.2% of the screen
 * or 3%. So every judgment of a tab's output is written down here, alongside
 * the moments it went quiet and the notifications that followed, and the
 * threshold dialog draws them -- and replays them against whatever is being
 * typed, so the effect of a setting is visible before it is saved.
 *
 * In memory and on the desktop only. It is a window onto the last half hour,
 * not a record anybody needs back after a reload, and the desktop is where the
 * judging happens.
 */

import { useSyncExternalStore } from "react";
import { classifyViewportChange } from "./viewportSignature";

export type ActivitySampleKind =
  /** Enough changed to count as work. */
  | "work"
  /** Something changed, but less than the threshold. */
  | "small"
  /** Only numbers changed: a clock, a counter. */
  | "numbers"
  /** The screen went blank, which is never news. */
  | "blank"
  /** Output arrived and the screen came back exactly as it was. */
  | "identical"
  /** Nothing earlier to compare with, so it counted. */
  | "baseline";

export interface ActivitySample {
  at: number;
  kind: ActivitySampleKind;
  /**
   * Share of the screen whose text differs from the last screen that counted,
   * 0–100. Measured from that screen rather than the previous capture, so a
   * screen creeping a few characters at a time adds up.
   */
  percent: number;
  changedRows: number;
  changedTextRows: number;
  changedTextChars: number;
  digitOnlyTextRows: number;
  cells: number;
  /** The change threshold this was judged against; unset is the built-in rule. */
  changePercent?: number;
}

export type ActivityEventKind =
  /** The tab's dot left green. */
  | "inactive"
  /** And came back. */
  | "active"
  /** The desktop chimed. */
  | "chime"
  /** A phone was sent a push. */
  | "push"
  /** Somebody typed into it. */
  | "input";

export interface ActivityEvent {
  at: number;
  kind: ActivityEventKind;
}

export interface ActivityHistory {
  samples: readonly ActivitySample[];
  events: readonly ActivityEvent[];
}

export const ACTIVITY_HISTORY_WINDOW_MS = 30 * 60_000;
const MAX_SAMPLES = 1_500;
const MAX_EVENTS = 400;

const EMPTY_HISTORY: ActivityHistory = { samples: [], events: [] };

interface HistoryEntry {
  samples: ActivitySample[];
  events: ActivityEvent[];
  snapshot: ActivityHistory | null;
}

const histories = new Map<string, HistoryEntry>();
const listeners = new Set<() => void>();

function entryFor(tabRootTerminalId: string): HistoryEntry {
  let entry = histories.get(tabRootTerminalId);
  if (!entry) {
    entry = { samples: [], events: [], snapshot: null };
    histories.set(tabRootTerminalId, entry);
  }
  return entry;
}

function prune<T extends { at: number }>(items: T[], max: number, now: number) {
  const cutoff = now - ACTIVITY_HISTORY_WINDOW_MS;
  let drop = 0;
  while (drop < items.length && (items[drop].at < cutoff || items.length - drop > max)) {
    drop += 1;
  }
  if (drop > 0) {
    items.splice(0, drop);
  }
}

function changed(entry: HistoryEntry) {
  entry.snapshot = null;
  for (const listener of listeners) {
    listener();
  }
}

export function recordActivitySample(tabRootTerminalId: string, sample: ActivitySample) {
  const entry = entryFor(tabRootTerminalId);
  entry.samples.push(sample);
  prune(entry.samples, MAX_SAMPLES, sample.at);
  changed(entry);
}

export function recordActivityEvent(tabRootTerminalId: string, event: ActivityEvent) {
  const entry = entryFor(tabRootTerminalId);
  entry.events.push(event);
  prune(entry.events, MAX_EVENTS, event.at);
  changed(entry);
}

export function forgetActivityHistory(tabRootTerminalId: string) {
  if (histories.delete(tabRootTerminalId)) {
    for (const listener of listeners) {
      listener();
    }
  }
}

/** Stable until something is recorded, which is what a React subscription needs. */
export function getActivityHistory(tabRootTerminalId: string): ActivityHistory {
  const entry = histories.get(tabRootTerminalId);
  if (!entry) {
    return EMPTY_HISTORY;
  }
  if (!entry.snapshot) {
    entry.snapshot = { samples: entry.samples.slice(), events: entry.events.slice() };
  }
  return entry.snapshot;
}

export function subscribeActivityHistory(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useActivityHistory(tabRootTerminalId: string | null): ActivityHistory {
  return useSyncExternalStore(
    subscribeActivityHistory,
    () => (tabRootTerminalId ? getActivityHistory(tabRootTerminalId) : EMPTY_HISTORY),
    () => EMPTY_HISTORY
  );
}

/** Whether a sample would have counted as work under a given setting. */
export function sampleCounts(sample: ActivitySample, changePercent: number | undefined): boolean {
  switch (sample.kind) {
    case "baseline":
      return true;
    case "blank":
    case "identical":
    case "numbers":
      return false;
    case "work":
    case "small":
      return classifyViewportChange(sample, { cells: sample.cells, changePercent }) === "work";
  }
}

export interface InactiveSpan {
  start: number;
  /** Null while it is still going on. */
  end: number | null;
}

export interface InactivityReplay {
  counted: boolean[];
  spans: InactiveSpan[];
  /** When the tab goes inactive if nothing else counts, or null if it already has. */
  inactiveAt: number | null;
  /** The last thing that counted as activity, if any did. */
  lastActivityAt: number | null;
}

/**
 * Play the recorded history through a setting.
 *
 * Mirrors the status machine's rule: a tab goes quiet once the duration has
 * passed since the last output that counted, or since the user last typed,
 * and stays quiet until something counts again. Under the built-in rule any
 * output at all also keeps it alive -- that is the "still running" signal a
 * spinner gives -- while a chosen percentage drops that, so output under it
 * neither counts nor keeps the tab green.
 *
 * Approximate when replaying a setting other than the one in force: each
 * sample was measured from the last screen that counted, and which screen that
 * was depended on the setting at the time.
 */
export function replayInactivity(args: {
  history: ActivityHistory;
  changePercent: number | undefined;
  inactivityMs: number;
  now: number;
}): InactivityReplay {
  const { history, changePercent, inactivityMs, now } = args;
  const counted = history.samples.map((sample) => sampleCounts(sample, changePercent));
  const keepsAliveWithoutCounting = changePercent === undefined;

  const points: { at: number; activity: boolean }[] = [];
  history.samples.forEach((sample, index) => {
    if (counted[index] || keepsAliveWithoutCounting) {
      points.push({ at: sample.at, activity: counted[index] });
    }
  });
  for (const event of history.events) {
    if (event.kind === "input") {
      points.push({ at: event.at, activity: true });
    }
  }
  points.sort((a, b) => a.at - b.at);

  const spans: InactiveSpan[] = [];
  let lastAlive: number | null = null;
  let lastActivityAt: number | null = null;
  let inactiveSince: number | null = null;
  for (const point of points) {
    if (inactiveSince === null && lastAlive !== null && point.at >= lastAlive + inactivityMs) {
      inactiveSince = lastAlive + inactivityMs;
    }
    if (inactiveSince !== null) {
      if (!point.activity) {
        // Still running, but the tab already went quiet, and only something
        // worth reading brings it back.
        continue;
      }
      spans.push({ start: inactiveSince, end: point.at });
      inactiveSince = null;
    }
    lastAlive = point.at;
    if (point.activity) {
      lastActivityAt = point.at;
    }
  }

  let inactiveAt: number | null = null;
  if (inactiveSince === null && lastAlive !== null) {
    if (now >= lastAlive + inactivityMs) {
      inactiveSince = lastAlive + inactivityMs;
    } else {
      inactiveAt = lastAlive + inactivityMs;
    }
  }
  if (inactiveSince !== null) {
    spans.push({ start: inactiveSince, end: null });
  }

  return { counted, spans, inactiveAt, lastActivityAt };
}
