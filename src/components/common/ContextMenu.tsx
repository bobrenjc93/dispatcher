import { useEffect, useRef, useState, type ReactNode } from "react";
import { resolveContextMenuPlacement } from "../../lib/contextMenuPosition";

export interface ContextMenuItem {
  label: string;
  icon?: ReactNode;
  shortcut?: string;
  onClick: () => void;
  danger?: boolean;
  checked?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handleClick, true);
    document.addEventListener("keydown", handleKey, true);
    return () => {
      document.removeEventListener("mousedown", handleClick, true);
      document.removeEventListener("keydown", handleKey, true);
    };
  }, [onClose]);

  // Keep the menu on the screen. Measured after the first paint, because the
  // height depends on how many items there are and how far they wrap.
  const [placement, setPlacement] = useState<{
    left: number;
    top: number;
    maxHeight: number | null;
  } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPlacement(
      resolveContextMenuPlacement({
        x,
        y,
        width: rect.width,
        height: rect.height,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      })
    );
  }, [x, y, items.length]);

  return (
    <div
      ref={ref}
      className="context-menu"
      style={{
        left: placement?.left ?? x,
        top: placement?.top ?? y,
        // Only set once measuring says the menu cannot fit, so a menu that
        // fits keeps its natural height and no scrollbar.
        ...(placement?.maxHeight === null || placement === null
          ? null
          : { maxHeight: placement.maxHeight, overflowY: "auto" as const }),
      }}
      role="menu"
    >
      {items.map((item, i) => (
        <button
          key={i}
          className={`context-menu-item ${item.danger ? "context-menu-danger" : ""}`}
          role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
          aria-checked={item.checked}
          onClick={() => {
            item.onClick();
            onClose();
          }}
        >
          {item.icon && <span className="context-menu-icon">{item.icon}</span>}
          <span className="context-menu-label">{item.label}</span>
          {item.shortcut && <span className="context-menu-shortcut">{item.shortcut}</span>}
          {item.checked !== undefined && (
            <span className="context-menu-check" aria-hidden="true">
              {item.checked && (
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M2.5 7.25L5.5 10L11.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
