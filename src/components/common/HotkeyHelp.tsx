import { useEffect } from "react";

interface HotkeyHelpProps {
  onClose: () => void;
}

const shortcuts = [
  { keys: "⌘T", description: "New terminal" },
  { keys: "⇧⌘T", description: "Reopen closed tab" },
  { keys: "⌘N", description: "New project" },
  { keys: "⌘W", description: "Close pane" },
  { keys: "⌘D", description: "Split right" },
  { keys: "⇧⌘D", description: "Split down" },
  { keys: "⌘R", description: "Rename terminal" },
  { keys: "⌘U", description: "Move to top" },
  { keys: "⌘B", description: "Move to bottom" },
  { keys: "⌘]", description: "Next project" },
  { keys: "⌘[", description: "Previous project" },
  { keys: "⇧⌘]", description: "Next terminal" },
  { keys: "⇧⌘[", description: "Previous terminal" },
  { keys: "⌘F", description: "Search in terminal" },
  { keys: "⌘K", description: "Clear terminal" },
  { keys: "⌘+", description: "Increase font size" },
  { keys: "⌘\u2212", description: "Decrease font size" },
  { keys: "⌘0", description: "Reset font size" },
  { keys: "⇧⌘P", description: "Color scheme" },
  { keys: "⇧⌘?", description: "Status debug" },
  // Mouse, but listed here for the same reason the rest is: nothing on screen
  // says these exist.
  { keys: "⇧ Click", description: "Select a range of tabs" },
  { keys: "⌘ Click", description: "Add a tab to the selection" },
  { keys: "⇧⌘ Click", description: "Add a range to the selection" },
];

export function HotkeyHelp({ onClose }: HotkeyHelpProps) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog hotkey-help-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="hotkey-help-header">
          <span className="dialog-title">Keyboard Shortcuts</span>
          <button className="hotkey-help-close" onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M3 3L11 11M11 3L3 11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
        <div className="hotkey-help-list">
          {shortcuts.map((s) => (
            <div key={s.keys} className="hotkey-help-row">
              <span className="hotkey-help-desc">{s.description}</span>
              <kbd className="hotkey-help-key">{s.keys}</kbd>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
