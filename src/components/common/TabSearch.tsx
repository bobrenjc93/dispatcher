import { useEffect, useMemo, useRef, useState } from "react";
import { useProjectStore } from "../../stores/useProjectStore";
import { useTerminalStore } from "../../stores/useTerminalStore";
import { useLayoutStore } from "../../stores/useLayoutStore";
import { findLayoutKeyForTerminal } from "../../lib/layoutUtils";
import { searchTabs, tabSearchEntries, type TabSearchEntry } from "../../lib/tabSearch";

interface TabSearchProps {
  onPick: (entry: TabSearchEntry) => void;
  onClose: () => void;
}

/** ⌘S: jump to a tab by typing part of its name. */
export function TabSearch({ onPick, onClose }: TabSearchProps) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const projects = useProjectStore((s) => s.projects);
  const projectOrder = useProjectStore((s) => s.projectOrder);
  const nodes = useProjectStore((s) => s.nodes);
  const sessions = useTerminalStore((s) => s.sessions);
  // A focused split pane belongs to the tab that holds it.
  const currentTabId = useTerminalStore((s) => s.activeTerminalId
    ? findLayoutKeyForTerminal(useLayoutStore.getState().layouts, s.activeTerminalId) ?? s.activeTerminalId
    : null);

  const entries = useMemo(
    () => tabSearchEntries({ projects, projectOrder, nodes, sessions }),
    [projects, projectOrder, nodes, sessions]
  );
  const results = useMemo(() => searchTabs(entries, query), [entries, query]);
  const showProjects = projectOrder.length > 1;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${selected}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const move = (delta: number) => {
    if (results.length === 0) return;
    setSelected((index) => (index + delta + results.length) % results.length);
  };

  return (
    <div className="dialog-overlay tab-search-overlay" onClick={onClose}>
      <div className="tab-search" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="tab-search-input"
          value={query}
          placeholder="Go to tab…"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
              e.preventDefault();
              move(1);
            } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
              e.preventDefault();
              move(-1);
            } else if (e.key === "Enter") {
              e.preventDefault();
              const entry = results[selected];
              if (entry) onPick(entry);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
        />
        <div ref={listRef} className="tab-search-results" role="listbox">
          {results.length === 0 && <div className="tab-search-empty">No tabs match</div>}
          {results.map((entry, index) => (
            <button
              key={entry.terminalId}
              data-index={index}
              role="option"
              aria-selected={index === selected}
              className={`tab-search-row${index === selected ? " is-selected" : ""}`}
              onMouseMove={() => setSelected(index)}
              onClick={() => onPick(entry)}
            >
              <span className="tab-search-title">{entry.title || "Terminal"}</span>
              {entry.terminalId === currentTabId && <span className="tab-search-current">current</span>}
              {showProjects && <span className="tab-search-project">{entry.projectName}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
