import { beforeEach, describe, expect, it } from "vitest";
import {
  announcesAttention,
  clearAttentionRequest,
  findAttentionMarkers,
  hasAttentionMarker,
  hasCarriedOnSince,
  noteAttentionRequested,
  peekAttentionRequest,
  resetAttentionRequests,
  shouldTrustQuiet,
} from "../attentionMarker";

const ESC = "\u001b";
const BEL = "\u0007";
const ST = "\u001b\\";

describe("findAttentionMarkers", () => {
  it("reads the marker Claude Code actually sends", () => {
    // Taken from the raw tmux stream of a pane that had just pushed a false
    // "inactive" notification while still working.
    expect(
      findAttentionMarkers(ESC + "]9;Claude is waiting for your input" + BEL)
    ).toEqual(["Claude is waiting for your input"]);
  });

  it("accepts the string terminator as well as BEL", () => {
    expect(findAttentionMarkers(ESC + "]9;done" + ESC + "\\")).toEqual(["done"]);
  });

  it("finds a marker buried in ordinary output", () => {
    const chunk = `some output\r\n${ESC}[32mgreen${ESC}[0m${ESC}]9;ready${BEL}more\r\n`;
    expect(findAttentionMarkers(chunk)).toEqual(["ready"]);
  });

  it("reads two markers in one chunk as two", () => {
    // Non-greedy, or the first terminator to the last would swallow both.
    expect(
      findAttentionMarkers(ESC + "]9;first" + BEL + "middle" + ESC + "]9;second" + BEL)
    ).toEqual(["first", "second"]);
  });

  it("ignores ConEmu progress, which shares the number", () => {
    // `OSC 9 ; 4 ; ...` is "halfway through", the opposite of wanting you.
    expect(findAttentionMarkers(ESC + "]9;4;1;50" + BEL)).toEqual([]);
    expect(findAttentionMarkers(ESC + "]9;4" + BEL)).toEqual([]);
  });

  it("ignores an empty message and unrelated sequences", () => {
    expect(findAttentionMarkers(ESC + "]9;" + BEL)).toEqual([]);
    expect(findAttentionMarkers(ESC + "]0;a window title" + BEL)).toEqual([]);
    expect(findAttentionMarkers(ESC + "]11;rgb:0a/0a/0a" + ESC + "\\")).toEqual([]);
    expect(findAttentionMarkers("no escapes here")).toEqual([]);
  });

  it("does not match an unterminated marker", () => {
    // A chunk boundary can split one; a half-read message is not an event.
    expect(findAttentionMarkers(ESC + "]9;Claude is wait")).toEqual([]);
  });

  it("answers the same question twice the same way", () => {
    // The pattern is global, so a leaked lastIndex would make the second call
    // disagree with the first.
    const chunk = ESC + "]9;ready" + BEL;
    expect(hasAttentionMarker(chunk)).toBe(true);
    expect(hasAttentionMarker(chunk)).toBe(true);
  });
});

describe("the registry two modules share", () => {
  beforeEach(() => {
    resetAttentionRequests();
  });

  it("is reachable from a second copy of the module", () => {
    // Recorded where output is decoded and read where notifications are
    // decided. A plain module-level map is a different map per module
    // instance, so a reload wrote the marker into one and read from another:
    // three recorded, none ever found. Everything shared across modules here
    // lives on globalThis for exactly this reason.
    noteAttentionRequested("tab", 1000);
    const runtime = (globalThis as { __dispatcherAttentionRuntime?: unknown })
      .__dispatcherAttentionRuntime;
    expect(runtime).toBeDefined();
    expect(peekAttentionRequest("tab", 0)).toBe(1000);
  });

  it("only reports a request newer than the last one acted on", () => {
    noteAttentionRequested("tab", 1000);
    expect(peekAttentionRequest("tab", 1000)).toBeNull();
    expect(peekAttentionRequest("tab", 999)).toBe(1000);
  });

  it("forgets a request once it has been acted on", () => {
    noteAttentionRequested("tab", 1000);
    clearAttentionRequest("tab");
    expect(peekAttentionRequest("tab", 0)).toBeNull();
  });

  it("remembers that a tab announces itself after the request is cleared", () => {
    // This is what retires the silence guess, so it has to outlive the single
    // request it came in on.
    noteAttentionRequested("tab", 1000);
    clearAttentionRequest("tab");
    expect(announcesAttention("tab")).toBe(true);
    expect(announcesAttention("other")).toBe(false);
  });

  it("remembers announcers across a reload", () => {
    // globalThis goes with the page. Forgetting on every reload hands the tab
    // back to the silence guess until its next marker, which is minutes of
    // pushes for a tab that has already proved it does not need guessing at.
    noteAttentionRequested("tab", 1000);
    expect(announcesAttention("tab")).toBe(true);

    // What a reload looks like: the runtime is gone, localStorage is not.
    delete (globalThis as { __dispatcherAttentionRuntime?: unknown })
      .__dispatcherAttentionRuntime;

    expect(announcesAttention("tab")).toBe(true);
    expect(announcesAttention("never-asked")).toBe(false);
  });
});

describe("shouldTrustQuiet", () => {
  it("believes a shell going quiet, because that is all a shell has", () => {
    expect(shouldTrustQuiet({ announces: false, hasPendingRequest: false })).toBe(true);
  });

  it("does not believe an announcer's quiet on its own", () => {
    // Pausing to think reads exactly like finishing. Five pushes in eight
    // minutes for a tab that was working the whole time.
    expect(shouldTrustQuiet({ announces: true, hasPendingRequest: false })).toBe(false);
  });

  it("believes it once the program has also said so", () => {
    // Both halves: it asked, and then it actually stopped. The marker alone is
    // not enough either -- seven in half an hour, each followed by the program
    // carrying on within a minute.
    expect(shouldTrustQuiet({ announces: true, hasPendingRequest: true })).toBe(true);
  });
});

describe("hasCarriedOnSince", () => {
  it("treats the marker's own burst as part of the marker", () => {
    // The marker rides inside the output that draws the prompt, so the change
    // it belongs to lands a beat after it.
    expect(hasCarriedOnSince({ askedAt: 1000, lastChangedAt: 1500 })).toBe(false);
  });

  it("sees the program starting up again", () => {
    // Observed: announced at 20:07:25, resumed at 20:09:00, then worked for
    // five more minutes. Keeping that request alive would pair it with the
    // next quiet stretch and call that a finish.
    expect(hasCarriedOnSince({ askedAt: 1000, lastChangedAt: 96_000 })).toBe(true);
  });

  it("does not count a change from before the marker", () => {
    expect(hasCarriedOnSince({ askedAt: 5000, lastChangedAt: 1000 })).toBe(false);
  });
});
