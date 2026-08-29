import { describe, expect, it } from "vitest";
import { resolveDictationInput, type DictationState } from "../dictationInput";

/** Feed a sequence the way the input funnel would, and collect what is sent. */
function run(updates: Array<{ data: string; at?: number }>): string {
  let state: DictationState | null = null;
  let sent = "";
  let clock = 0;
  for (const update of updates) {
    clock = update.at ?? clock + 100;
    const result = resolveDictationInput({ data: update.data, previous: state, now: clock });
    sent += result.emit;
    state = result.next;
  }
  return sent;
}

describe("resolveDictationInput", () => {
  it("collapses the revisions iOS dictation actually sends", () => {
    // Captured from a phone dictating "can you do it for me": every update
    // carries the whole phrase so far, which used to concatenate into
    // "ccancan ycan youcan you d…".
    const dictation = [
      "c",
      "can",
      "can y",
      "can you",
      "can you d",
      "can you do",
      "can you do it for me?",
      "can you do it for me?",
    ].map((data) => ({ data }));

    expect(run(dictation)).toBe("can you do it for me?");
  });

  it("drops the duplicate final result without dropping a retyped word", () => {
    // Dictation sends the finished phrase twice; a person pasting the same
    // short thing twice is rare, and a repeated single key must still repeat.
    expect(run([{ data: "hello" }, { data: "hello" }])).toBe("hello");
    expect(run([{ data: "a" }, { data: "a" }])).toBe("aa");
  });

  it("leaves ordinary typing alone", () => {
    expect(run([{ data: "l" }, { data: "s" }, { data: " " }, { data: "-" }, { data: "l" }]))
      .toBe("ls -l");
  });

  it("does not swallow a repeated character", () => {
    // "aa" must stay "aa": the second is not longer than the first, so it is
    // not a revision.
    expect(run([{ data: "a" }, { data: "a" }])).toBe("aa");
  });

  it("passes control input straight through and ends the utterance", () => {
    // Enter after a phrase, then a new phrase that happens to share a prefix.
    expect(run([{ data: "hello" }, { data: "\r" }, { data: "hello there" }]))
      .toBe("hello\rhello there");
  });

  it("treats a late revision as a new utterance", () => {
    // Six seconds later the user is typing, not still dictating.
    expect(run([{ data: "can", at: 0 }, { data: "can you", at: 6_000 }]))
      .toBe("cancan you");
  });

  it("passes a correction through rather than guessing", () => {
    // Dictation sometimes rewrites instead of extending. Nothing can be
    // salvaged from that, so send it and let the user see what happened.
    expect(run([{ data: "can you" }, { data: "Can you" }])).toBe("can youCan you");
  });
});
