import { useEffect } from "react";
import { useColorSchemeStore } from "../../stores/useColorSchemeStore";
import { BUILTIN_SCHEMES } from "../../lib/colorSchemes";

interface SchemePickerProps {
  onClose: () => void;
}

const SWATCH_KEYS = ["terminal.background", "terminal.foreground", "terminal.red", "terminal.green", "terminal.blue", "terminal.yellow"] as const;

function getSwatchColor(scheme: (typeof BUILTIN_SCHEMES)[number], key: (typeof SWATCH_KEYS)[number]): string {
  const [section, prop] = key.split(".") as ["terminal", string];
  return (scheme[section] as unknown as Record<string, string>)[prop];
}

export function SchemePicker({ onClose }: SchemePickerProps) {
  const schemeId = useColorSchemeStore((s) => s.schemeId);
  const setScheme = useColorSchemeStore((s) => s.setScheme);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog scheme-picker-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="scheme-picker-header">
          <span className="dialog-title">Color Scheme</span>
          <button className="hotkey-help-close" onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M3 3L11 11M11 3L3 11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
        <div className="scheme-picker-list">
          {BUILTIN_SCHEMES.map((scheme) => (
            <button
              key={scheme.id}
              className={`scheme-picker-row${scheme.id === schemeId ? " scheme-picker-row-active" : ""}`}
              onClick={() => setScheme(scheme.id)}
            >
              <span className="scheme-picker-name">{scheme.name}</span>
              <div className="scheme-picker-swatches">
                {SWATCH_KEYS.map((key) => (
                  <span
                    key={key}
                    className="scheme-picker-swatch"
                    style={{ background: getSwatchColor(scheme, key) }}
                  />
                ))}
              </div>
              {scheme.id === schemeId && (
                <svg className="scheme-picker-check" width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M3 7.5L5.5 10L11 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
