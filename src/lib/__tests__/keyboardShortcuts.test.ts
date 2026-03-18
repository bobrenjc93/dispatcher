import { describe, expect, it } from "vitest";
import {
  getCtrlLetterControlCharacter,
  getMacOptionMetaSequence,
  isEventInsideTerminal,
  isPlainCtrlLetterShortcut,
  suppressMacCtrlChordTextInput,
  shouldBypassAppShortcutsForTerminal,
} from "../keyboardShortcuts";

describe("keyboardShortcuts", () => {
  it("treats Ctrl+letter as a terminal control chord", () => {
    expect(isPlainCtrlLetterShortcut({ ctrlKey: true, metaKey: false, altKey: false, key: "r" })).toBe(true);
    expect(isPlainCtrlLetterShortcut({ ctrlKey: true, metaKey: false, altKey: false, key: "R" })).toBe(true);
  });

  it("does not treat non-letter or modified shortcuts as terminal control chords", () => {
    expect(isPlainCtrlLetterShortcut({ ctrlKey: true, metaKey: false, altKey: false, key: "]" })).toBe(false);
    expect(isPlainCtrlLetterShortcut({ ctrlKey: true, metaKey: false, altKey: true, key: "r" })).toBe(false);
    expect(isPlainCtrlLetterShortcut({ ctrlKey: false, metaKey: true, altKey: false, key: "r" })).toBe(false);
  });

  it("maps Ctrl+letter key codes to terminal control characters", () => {
    expect(
      getCtrlLetterControlCharacter({
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        code: "KeyO",
      })
    ).toBe("\u000f");

    expect(
      getCtrlLetterControlCharacter({
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: true,
        code: "KeyO",
      })
    ).toBeNull();

    expect(
      getCtrlLetterControlCharacter({
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        code: "BracketLeft",
      })
    ).toBeNull();
  });

  it("maps mac Option chords to ESC-prefixed Meta sequences", () => {
    expect(
      getMacOptionMetaSequence({
        ctrlKey: false,
        metaKey: false,
        altKey: true,
        shiftKey: false,
        code: "KeyQ",
      })
    ).toBe("\u001bq");

    expect(
      getMacOptionMetaSequence({
        ctrlKey: false,
        metaKey: false,
        altKey: true,
        shiftKey: true,
        code: "KeyQ",
      })
    ).toBe("\u001bQ");

    expect(
      getMacOptionMetaSequence({
        ctrlKey: false,
        metaKey: false,
        altKey: true,
        shiftKey: false,
        code: "BracketLeft",
      })
    ).toBe("\u001b[");

    expect(
      getMacOptionMetaSequence({
        ctrlKey: false,
        metaKey: true,
        altKey: true,
        shiftKey: false,
        code: "KeyQ",
      })
    ).toBeNull();
  });

  it("detects when the event target is inside a terminal pane", () => {
    const pane = document.createElement("div");
    pane.className = "terminal-pane";
    const child = document.createElement("div");
    pane.appendChild(child);

    expect(isEventInsideTerminal(child)).toBe(true);
    expect(isEventInsideTerminal(document.createElement("div"))).toBe(false);
  });

  it("bypasses app shortcuts for Ctrl+letter events inside terminals only", () => {
    const pane = document.createElement("div");
    pane.className = "terminal-pane";
    const child = document.createElement("div");
    pane.appendChild(child);

    expect(
      shouldBypassAppShortcutsForTerminal({
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        key: "r",
        target: child,
      })
    ).toBe(true);

    expect(
      shouldBypassAppShortcutsForTerminal({
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        key: "]",
        target: child,
      })
    ).toBe(false);

    expect(
      shouldBypassAppShortcutsForTerminal({
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        key: "r",
        target: document.createElement("div"),
      })
    ).toBe(false);
  });

  it("suppresses leaked macOS text input events after Ctrl chords", () => {
    const target = document.createElement("textarea");
    document.body.appendChild(target);

    let leakedInputCount = 0;
    target.addEventListener("beforeinput", () => {
      leakedInputCount += 1;
    });

    const cleanup = suppressMacCtrlChordTextInput(target);
    const leakedEvent = new Event("beforeinput", { bubbles: true, cancelable: true });

    expect(target.dispatchEvent(leakedEvent)).toBe(false);
    expect(leakedInputCount).toBe(0);

    cleanup();

    const normalEvent = new Event("beforeinput", { bubbles: true, cancelable: true });
    expect(target.dispatchEvent(normalEvent)).toBe(true);
    expect(leakedInputCount).toBe(1);
  });
});
