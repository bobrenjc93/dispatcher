import { useEffect, useRef, useState } from "react";
import { useTerminalStore } from "../../stores/useTerminalStore";
import { useUiStore } from "../../stores/useUiStore";
import { readClipboardText } from "../../lib/clipboardRead";
import {
  pasteTextIntoTerminalById,
  readTerminalVisibleText,
  sendSyntheticTerminalInput,
} from "../../hooks/useTerminalBridge";

/**
 * The keys a phone keyboard does not have.
 *
 * Escape, Tab, the arrows and Ctrl chords are everyday terminal input and no
 * soft keyboard offers them. Ctrl is sticky: arm it, then type a letter, and
 * the two are folded into a control code on the way to the terminal.
 */

interface KeyDefinition {
  label: string;
  data: string;
  title: string;
  wide?: boolean;
}

const ESC = "\u001b";

/**
 * The keys worth reaching for without a swipe.
 *
 * The bar scrolls horizontally on a phone, so position is not cosmetic: what
 * sits past the fold costs a gesture before it costs a tap. These are the ones
 * used constantly — history, Enter, interrupt, search, and clearing the line.
 */
const LEADING_KEYS: KeyDefinition[] = [
  { label: "\u2191", data: `${ESC}[A`, title: "Up" },
  { label: "\u2193", data: `${ESC}[B`, title: "Down" },
  // Carriage return, not newline: that is what a terminal reads as Enter.
  { label: "enter", data: "\r", title: "Enter" },
  { label: "^C", data: "\u0003", title: "Ctrl+C \u2014 interrupt" },
  { label: "^R", data: "\u0012", title: "Ctrl+R \u2014 reverse search" },
  { label: "^U", data: "\u0015", title: "Ctrl+U \u2014 clear the line" },
];

/** Everything else, keeping the order it already had. */
const TRAILING_KEYS: KeyDefinition[] = [
  { label: "esc", data: ESC, title: "Escape" },
  { label: "tab", data: "\t", title: "Tab" },
  { label: "\u2190", data: `${ESC}[D`, title: "Left" },
  { label: "\u2192", data: `${ESC}[C`, title: "Right" },
];

/**
 * A field to paste into, for when the page cannot read the clipboard itself.
 *
 * The terminal is a canvas, so a long-press over it offers nothing to paste
 * into. A real text field does, and the browser will happily fill one from the
 * clipboard on the user's own gesture even where it refuses to hand the same
 * text to script. Two extra taps, but it works on plain HTTP.
 */
function PasteTarget(props: { onSubmit: (text: string) => void; onCancel: () => void }) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    // Best effort: iOS may decline to raise the keyboard for a focus it did not
    // consider user-initiated, in which case tapping the field does it.
    inputRef.current?.focus();
  }, []);

  return (
    <div
      className="paste-target-backdrop"
      role="presentation"
      onPointerDown={props.onCancel}
    >
      <div
        className="paste-target"
        role="dialog"
        aria-label="Paste into terminal"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <p className="paste-target-hint">Long-press the box, choose Paste.</p>
        <textarea
          ref={inputRef}
          className="paste-target-input"
          rows={2}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="Paste here"
          onPaste={(event) => {
            // Take the text off the event rather than reading the field back:
            // this fires before the value lands, and it is the only path that
            // sees the paste whole, newlines and all.
            const text = event.clipboardData?.getData("text");
            if (text) {
              event.preventDefault();
              props.onSubmit(text);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              props.onCancel();
            }
          }}
        />
        <div className="paste-target-actions">
          <button type="button" className="mobile-key" onClick={props.onCancel}>
            cancel
          </button>
          <button
            type="button"
            className="mobile-key"
            onClick={() => props.onSubmit(inputRef.current?.value ?? "")}
          >
            send
          </button>
        </div>
      </div>
    </div>
  );
}

export function MobileKeyBar() {
  const activeTerminalId = useTerminalStore((s) => s.activeTerminalId);
  const isCtrlArmed = useUiStore((s) => s.isCtrlArmed);
  const setCtrlArmed = useUiStore((s) => s.setCtrlArmed);
  const [isPasteTargetOpen, setPasteTargetOpen] = useState(false);

  if (!activeTerminalId) {
    return null;
  }

  const send = (data: string) => {
    sendSyntheticTerminalInput(activeTerminalId, data);
    setCtrlArmed(false);
  };

  // Pressing a key must not move focus, or the soft keyboard would close
  // between every keystroke.
  const keepFocus = (event: React.PointerEvent | React.MouseEvent) => {
    event.preventDefault();
  };

  // A finger cannot drag-select a canvas, so offer the text directly: the
  // selection if there is one, otherwise what is on screen.
  const copyVisible = () => {
    const text = readTerminalVisibleText(activeTerminalId);
    if (text) {
      void navigator.clipboard?.writeText(text).catch(() => {});
    }
  };

  // A phone keyboard has no paste key, and the terminal is a canvas, so the
  // usual long-press-to-paste never reaches it. The clipboard read is the
  // browser's own — the phone's clipboard, not the desktop's, which is what
  // someone pasting on their phone means. Over plain HTTP there is no clipboard
  // API to ask, so fall back to a field the user can paste into by hand.
  const pasteClipboard = () => {
    void readClipboardText(navigator.clipboard).then((text) => {
      if (text) {
        return pasteTextIntoTerminalById(activeTerminalId, text);
      }
      setPasteTargetOpen(true);
    });
  };

  const submitPastedText = (text: string) => {
    setPasteTargetOpen(false);
    if (text) {
      void pasteTextIntoTerminalById(activeTerminalId, text);
    }
  };

  return (
    <>
      {isPasteTargetOpen && (
        <PasteTarget
          onSubmit={submitPastedText}
          onCancel={() => setPasteTargetOpen(false)}
        />
      )}
      <div className="mobile-key-bar" role="toolbar" aria-label="Terminal keys">
        {LEADING_KEYS.map((key) => (
          <button
            key={key.label}
            type="button"
            className="mobile-key"
            title={key.title}
            onPointerDown={keepFocus}
            onMouseDown={keepFocus}
            onClick={() => send(key.data)}
          >
            {key.label}
          </button>
        ))}
        <button
          type="button"
          className={`mobile-key${isCtrlArmed ? " is-armed" : ""}`}
          aria-pressed={isCtrlArmed}
          title="Ctrl — then press a key"
          onPointerDown={keepFocus}
          onMouseDown={keepFocus}
          onClick={() => setCtrlArmed(!isCtrlArmed)}
        >
          ctrl
        </button>
        <button
          type="button"
          className="mobile-key"
          title="Copy the selection, or the visible screen"
          onPointerDown={keepFocus}
          onMouseDown={keepFocus}
          onClick={copyVisible}
        >
          copy
        </button>
        <button
          type="button"
          className="mobile-key"
          title="Paste from the clipboard"
          onPointerDown={keepFocus}
          onMouseDown={keepFocus}
          onClick={pasteClipboard}
        >
          paste
        </button>
        {TRAILING_KEYS.map((key) => (
          <button
            key={key.label}
            type="button"
            className="mobile-key"
            title={key.title}
            onPointerDown={keepFocus}
            onMouseDown={keepFocus}
            onClick={() => send(key.data)}
          >
            {key.label}
          </button>
        ))}
      </div>
    </>
  );
}
