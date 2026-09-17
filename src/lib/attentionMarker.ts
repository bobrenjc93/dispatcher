/**
 * A program saying, in so many words, that it wants you.
 *
 * Dispatcher decides a tab needs attention by watching it go quiet, which is a
 * guess and a poor one for an agent: pausing to think, or waiting on a tool
 * call that takes two minutes, looks exactly like being finished. Six of eight
 * such notifications in one afternoon were followed by the tab carrying on
 * within seconds of the push landing.
 *
 * Meanwhile the program states it outright. Claude Code emits OSC 9 -- the
 * desktop-notification escape -- with "Claude is waiting for your input", and
 * that marker was sitting unread in the stream of the very panes that cried
 * wolf. Silence is an inference; this is the answer.
 *
 * Kept as a fallback rather than a replacement: `make` does not announce
 * itself, and a tab running one still has nothing but quiet to go on.
 */

import { getScopedStorageKey } from "./storageNamespace";

/**
 * OSC 9, in both the terminators the spec allows.
 *
 * `\x1b]9;<text>` closed by BEL or ST. Non-greedy, so two markers in one chunk
 * are two matches rather than one spanning both.
 */
const ATTENTION_MARKER_PATTERN = /\x1b\]9;([\s\S]*?)(?:\x07|\x1b\\)/g;

/**
 * ConEmu's progress reports share the OSC 9 number.
 *
 * `\x1b]9;4;1;50\x07` is "50% done", which is the opposite of wanting
 * attention -- it is a program getting on with it. Only the plain message form
 * is a notification.
 */
function isProgressReport(body: string): boolean {
  return /^4(;|$)/.test(body);
}

/** Every attention message in a chunk of pane output, in order. */
export function findAttentionMarkers(data: string): string[] {
  if (!data.includes("]9;")) {
    return [];
  }
  const found: string[] = [];
  ATTENTION_MARKER_PATTERN.lastIndex = 0;
  let match = ATTENTION_MARKER_PATTERN.exec(data);
  while (match !== null) {
    const body = match[1];
    if (body.length > 0 && !isProgressReport(body)) {
      found.push(body);
    }
    match = ATTENTION_MARKER_PATTERN.exec(data);
  }
  ATTENTION_MARKER_PATTERN.lastIndex = 0;
  return found;
}

/** Whether a chunk contains any. */
export function hasAttentionMarker(data: string): boolean {
  return findAttentionMarkers(data).length > 0;
}

/**
 * Markers seen but not yet acted on, by tab.
 *
 * Recorded where the output is decoded and read where notifications are
 * decided, which are far apart and have no reason to know about each other.
 * Keyed on the tab root, because that is what a notification is about -- a
 * split tab with two panes is still one thing to be told about.
 */
interface AttentionRuntime {
  requestedAt: Map<string, number>;
  /** Tabs that have ever asked, so silence can stop speaking for them. */
  everAsked: Set<string>;
}

declare global {
  // eslint-disable-next-line no-var
  var __dispatcherAttentionRuntime: AttentionRuntime | undefined;
}

/**
 * Held on globalThis, like every other piece of state two modules share here.
 *
 * A plain module-level map is a different map per module instance, and a dev
 * reload hands one side a fresh copy: the marker was recorded into one and
 * read from another, so it was written three times and found none.
 */
function runtime(): AttentionRuntime {
  const existing = globalThis.__dispatcherAttentionRuntime;
  if (existing) {
    existing.requestedAt ??= new Map();
    existing.everAsked ??= readAnnouncers();
    return existing;
  }
  const created: AttentionRuntime = { requestedAt: new Map(), everAsked: readAnnouncers() };
  globalThis.__dispatcherAttentionRuntime = created;
  return created;
}

/**
 * Which tabs announce themselves, across reloads.
 *
 * Whether a program says when it wants you is a fact about the program, not
 * about this run of the app -- but globalThis goes with the page. Forgetting
 * on every reload hands the tab straight back to the silence guess until its
 * next marker, which can be ten minutes of pushes for a tab that has already
 * proved it does not need guessing about.
 *
 * Desktop-local, like the closed-tab list: a convenience for the machine
 * doing the notifying, not part of the workspace document.
 */
const ANNOUNCERS_KEY = getScopedStorageKey("dispatcher.attentionAnnouncers");

function readAnnouncers(): Set<string> {
  if (typeof window === "undefined") {
    return new Set();
  }
  try {
    const raw = window.localStorage.getItem(ANNOUNCERS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function writeAnnouncers(ids: Set<string>) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(ANNOUNCERS_KEY, JSON.stringify([...ids]));
  } catch {
    // Losing it costs a reload's worth of guessing, not correctness.
  }
}

export function noteAttentionRequested(tabRootTerminalId: string, at: number = Date.now()) {
  const state = runtime();
  state.requestedAt.set(tabRootTerminalId, at);
  if (!state.everAsked.has(tabRootTerminalId)) {
    state.everAsked.add(tabRootTerminalId);
    writeAnnouncers(state.everAsked);
  }
}

/**
 * Whether this tab announces itself.
 *
 * Once a tab has asked outright even once, its silence stops being evidence:
 * the program pauses to think and says nothing, which is not the same as
 * finishing, and guessing from quiet is what produced five pushes in eight
 * minutes for a tab that was working the whole time.
 */
export function announcesAttention(tabRootTerminalId: string): boolean {
  return runtime().everAsked.has(tabRootTerminalId);
}

/** The pending request, if it is newer than the last one acted on. */
export function peekAttentionRequest(tabRootTerminalId: string, since: number): number | null {
  const at = runtime().requestedAt.get(tabRootTerminalId);
  return at !== undefined && at > since ? at : null;
}

export function clearAttentionRequest(tabRootTerminalId: string) {
  runtime().requestedAt.delete(tabRootTerminalId);
}

/** Test seam. */
export function resetAttentionRequests() {
  const state = runtime();
  state.requestedAt.clear();
  state.everAsked.clear();
  writeAnnouncers(state.everAsked);
}

/**
 * Whether a quiet stretch is worth believing.
 *
 * Neither signal stands alone. Silence calls a thinking agent finished, which
 * is how one tab pushed five times in eight minutes while working throughout.
 * A marker on its own is wrong the other way: it means "I paused", and seven
 * of them in half an hour were each followed by the program carrying on within
 * one to forty-nine seconds.
 *
 * Together they are precise -- it said it wanted you, and then it stopped. A
 * program that never announces has only the quiet, which is all there has ever
 * been for a shell.
 */
export function shouldTrustQuiet(args: {
  announces: boolean;
  hasPendingRequest: boolean;
}): boolean {
  return !args.announces || args.hasPendingRequest;
}
