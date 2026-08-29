import { useTerminalStore } from "../../stores/useTerminalStore";
import { useUiStore } from "../../stores/useUiStore";
import {
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

const KEYS: KeyDefinition[] = [
  { label: "esc", data: ESC, title: "Escape" },
  { label: "tab", data: "\t", title: "Tab" },
  { label: "^C", data: "\u0003", title: "Ctrl+C \u2014 interrupt" },
  { label: "^R", data: "\u0012", title: "Ctrl+R \u2014 reverse search" },
  { label: "\u2191", data: `${ESC}[A`, title: "Up" },
  { label: "\u2193", data: `${ESC}[B`, title: "Down" },
  { label: "\u2190", data: `${ESC}[D`, title: "Left" },
  { label: "\u2192", data: `${ESC}[C`, title: "Right" },
];

export function MobileKeyBar() {
  const activeTerminalId = useTerminalStore((s) => s.activeTerminalId);
  const isCtrlArmed = useUiStore((s) => s.isCtrlArmed);
  const setCtrlArmed = useUiStore((s) => s.setCtrlArmed);

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

  return (
    <div className="mobile-key-bar" role="toolbar" aria-label="Terminal keys">
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
      {KEYS.map((key) => (
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
  );
}
