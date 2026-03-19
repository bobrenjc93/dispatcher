import { useEffect, useCallback } from "react";
import { useFontStore } from "../../stores/useFontStore";
import type { FontWeight } from "../../stores/useFontStore";
import { useColorSchemeStore } from "../../stores/useColorSchemeStore";
import { showFontPanel, hideFontPanel } from "../../lib/tauriCommands";
import { listen } from "@tauri-apps/api/event";

interface FontSettingsProps {
  onClose: () => void;
}

const NERD_FONT_FALLBACKS = [
  "Symbols Nerd Font Mono",
  "Symbols Nerd Font",
];

function buildFontFamilyCSS(family: string): string {
  const fonts = [
    family,
    ...NERD_FONT_FALLBACKS,
    "Menlo",
    "Monaco",
    "Courier New",
    "monospace",
  ];

  return fonts
    .map((font) => (font === "monospace" ? font : `"${font}"`))
    .join(", ");
}

function weightLabel(w: FontWeight): string {
  switch (w) {
    case "100": return "Thin";
    case "200": return "Extra Light";
    case "300": return "Light";
    case "normal": return "Regular";
    case "500": return "Medium";
    case "600": return "Semi Bold";
    case "bold": return "Bold";
    case "800": return "Extra Bold";
    case "900": return "Black";
    default: return w;
  }
}

interface FontSelection {
  family: string;
  size: number;
  weight: string;
}

export function FontSettings({ onClose }: FontSettingsProps) {
  const fontFamily = useFontStore((s) => s.fontFamily);
  const fontSize = useFontStore((s) => s.fontSize);
  const fontWeight = useFontStore((s) => s.fontWeight);
  const lineHeight = useFontStore((s) => s.lineHeight);
  const letterSpacing = useFontStore((s) => s.letterSpacing);

  const setFontFamily = useFontStore((s) => s.setFontFamily);
  const setFontSize = useFontStore((s) => s.setFontSize);
  const setFontWeight = useFontStore((s) => s.setFontWeight);
  const setLineHeight = useFontStore((s) => s.setLineHeight);
  const setLetterSpacing = useFontStore((s) => s.setLetterSpacing);
  const resetAll = useFontStore((s) => s.resetAll);

  const terminalColors = useColorSchemeStore((s) => s.getActiveScheme().terminal);

  // Listen for font selections from the native panel
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<FontSelection>("font-panel-changed", (event) => {
      const { family, size, weight } = event.payload;
      setFontFamily(family);
      setFontSize(size);
      setFontWeight(weight as FontWeight);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [setFontFamily, setFontSize, setFontWeight]);

  // Close native font panel when dialog unmounts
  useEffect(() => {
    return () => {
      hideFontPanel().catch(() => {});
    };
  }, []);

  // Escape to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const handleOpenFontPanel = useCallback(() => {
    showFontPanel(fontFamily, fontSize, fontWeight).catch(() => {});
  }, [fontFamily, fontSize, fontWeight]);

  const fontSummary = `${fontFamily} ${weightLabel(fontWeight)} ${fontSize}pt`;

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog font-settings-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="font-settings-header">
          <span className="dialog-title">Font</span>
          <button className="hotkey-help-close" onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M3 3L11 11M11 3L3 11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        {/* Font picker row — opens native macOS font panel */}
        <div className="font-settings-font-row" onClick={handleOpenFontPanel}>
          <div className="font-settings-font-display" style={{ fontFamily: buildFontFamilyCSS(fontFamily) }}>
            {fontSummary}
          </div>
          <button className="font-settings-change-btn" onClick={handleOpenFontPanel}>
            Change...
          </button>
        </div>

        {/* Line Height + Letter Spacing */}
        <div className="font-settings-grid">
          <div className="font-settings-row">
            <label className="font-settings-label">Line Height</label>
            <div className="font-settings-stepper">
              <button onClick={() => setLineHeight(Math.max(0.8, +(lineHeight - 0.1).toFixed(1)))}>
                <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 5h6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
              </button>
              <input
                type="number"
                className="font-settings-number"
                value={lineHeight}
                min={0.8}
                max={2.0}
                step={0.1}
                onChange={(e) => setLineHeight(Number(e.target.value))}
              />
              <button onClick={() => setLineHeight(Math.min(2.0, +(lineHeight + 0.1).toFixed(1)))}>
                <svg width="10" height="10" viewBox="0 0 10 10"><path d="M5 2v6M2 5h6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
              </button>
            </div>
          </div>
          <div className="font-settings-row">
            <label className="font-settings-label">Letter Spacing</label>
            <div className="font-settings-stepper">
              <button onClick={() => setLetterSpacing(Math.max(-5, letterSpacing - 1))}>
                <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 5h6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
              </button>
              <input
                type="number"
                className="font-settings-number"
                value={letterSpacing}
                min={-5}
                max={10}
                onChange={(e) => setLetterSpacing(Number(e.target.value))}
              />
              <button onClick={() => setLetterSpacing(Math.min(10, letterSpacing + 1))}>
                <svg width="10" height="10" viewBox="0 0 10 10"><path d="M5 2v6M2 5h6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
              </button>
            </div>
          </div>
        </div>

        {/* Live Preview */}
        <div
          className="font-settings-preview"
          style={{
            fontFamily: buildFontFamilyCSS(fontFamily),
            fontSize,
            fontWeight,
            lineHeight,
            letterSpacing,
            background: terminalColors.background,
            color: terminalColors.foreground,
          }}
        >
          <div>
            <span style={{ color: terminalColors.green }}>user</span>
            <span style={{ color: terminalColors.brightBlack }}>:</span>
            <span style={{ color: terminalColors.blue }}>~/project</span>
            <span style={{ color: terminalColors.brightBlack }}> $ </span>
            echo &quot;Hello, World!&quot;
          </div>
          <div>Hello, World!</div>
          <div>
            <span>ABCDEFGHIJKLM </span>
            <span style={{ color: terminalColors.yellow }}>0123456789</span>
          </div>
          <div>
            <span style={{ color: terminalColors.magenta }}>{"const "}</span>
            <span>x = </span>
            <span style={{ color: terminalColors.cyan }}>{"[1, 2, 3]"}</span>
            <span style={{ color: terminalColors.brightBlack }}>{" // array"}</span>
          </div>
          <div>
            <span style={{ color: terminalColors.green }}>{" "}</span>
            <span>{" main 󰘬 nf-glyph-check"}</span>
          </div>
        </div>

        {/* Footer */}
        <div className="font-settings-footer">
          <button className="font-settings-reset" onClick={resetAll}>
            Reset
          </button>
        </div>
      </div>
    </div>
  );
}

export { buildFontFamilyCSS };
