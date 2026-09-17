import { describe, expect, it } from "vitest";
import { findAttentionMarkers, hasAttentionMarker } from "../attentionMarker";

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
