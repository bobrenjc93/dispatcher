import { useEffect, useState, useCallback } from "react";
import { useLayoutStore } from "../../stores/useLayoutStore";
import { useTerminalStore } from "../../stores/useTerminalStore";
import { useUiStore } from "../../stores/useUiStore";
import { DetailPanel } from "../Terminal/DetailPanel";
import { SplitContainer } from "./SplitContainer";
import { useResizeObserver } from "../../hooks/useResizeObserver";
import {
  beginTmuxPaneResizeByTerminal,
  isDisconnectedTmuxPlaceholderTerminal,
  isTmuxWindowTerminal,
  resizeTmuxPaneByTerminal,
  syncTmuxWindowSize,
} from "../../lib/tmuxControl";
import { getTerminalCellSize } from "../../hooks/useTerminalBridge";
import { getScopedStorageKey } from "../../lib/storageNamespace";

const DETAIL_PANEL_WIDTH_KEY = getScopedStorageKey("dispatcher.detailPanelWidth");
const DEFAULT_DETAIL_PANEL_WIDTH = 260;
const MIN_DETAIL_PANEL_WIDTH = 180;
const MAX_DETAIL_PANEL_WIDTH = 480;

function clampDetailPanelWidth(width: number): number {
  return Math.max(MIN_DETAIL_PANEL_WIDTH, Math.min(MAX_DETAIL_PANEL_WIDTH, width));
}

function getInitialDetailPanelWidth(): number {
  if (typeof window === "undefined") return DEFAULT_DETAIL_PANEL_WIDTH;
  const stored = Number(window.localStorage.getItem(DETAIL_PANEL_WIDTH_KEY));
  return Number.isFinite(stored)
    ? clampDetailPanelWidth(stored)
    : DEFAULT_DETAIL_PANEL_WIDTH;
}

interface ProjectViewProps {
  layoutId: string;
  onSplitPane: (targetTerminalId: string, direction: "horizontal" | "vertical") => void;
  onClosePane: (terminalId: string) => void;
}

export function ProjectView({ layoutId, onSplitPane, onClosePane }: ProjectViewProps) {
  const layout = useLayoutStore((s) => s.layouts[layoutId]);
  const activeTerminalId = useTerminalStore((s) => s.activeTerminalId);
  const [detailWidth, setDetailWidth] = useState(getInitialDetailPanelWidth);
  const detailCollapsed = useUiStore((s) => s.isDetailPanelCollapsed);
  const setDetailPanelCollapsed = useUiStore((s) => s.setDetailPanelCollapsed);
  const terminalCanvasRef = useResizeObserver((entry) => {
    syncTmuxWindowSize(layoutId, entry.contentRect.width, entry.contentRect.height);
  });

  const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = detailWidth;

    const onMouseMove = (e: MouseEvent) => {
      const newWidth = clampDetailPanelWidth(startWidth + (e.clientX - startX));
      setDetailWidth(newWidth);
      window.localStorage.setItem(DETAIL_PANEL_WIDTH_KEY, String(newWidth));
    };

    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [detailWidth]);

  if (!layout) {
    return (
      <div className="empty-view">
        <p>No terminals open</p>
      </div>
    );
  }

  // The detail panel always shows the tab root terminal's title/notes —
  // split panes are purely a layout concern and don't have their own metadata.
  // Split actions still target whichever pane is currently focused.
  const splitTarget = activeTerminalId ?? layoutId;
  const isDisconnectedTmuxPlaceholder = isDisconnectedTmuxPlaceholderTerminal(layoutId);
  const isTmuxLayout = isTmuxWindowTerminal(layoutId);

  const handleTmuxPaneDragEnd = useCallback(
    (
      terminalId: string,
      direction: "horizontal" | "vertical",
      ratio: number,
      oldRatio: number,
      containerPx: number
    ) => {
      const cellSize = getTerminalCellSize(terminalId);
      if (!cellSize) {
        resizeTmuxPaneByTerminal(terminalId, direction, 0);
        return;
      }

      const cellPx = direction === "horizontal" ? cellSize.width : cellSize.height;
      const deltaCells = Math.round(((ratio - oldRatio) * containerPx) / cellPx);
      resizeTmuxPaneByTerminal(terminalId, direction, deltaCells);
    },
    []
  );

  useEffect(() => {
    const element = terminalCanvasRef.current;
    if (!element) {
      return;
    }

    const frameId = requestAnimationFrame(() => {
      syncTmuxWindowSize(layoutId, element.clientWidth, element.clientHeight);
    });

    return () => cancelAnimationFrame(frameId);
  }, [layoutId, detailWidth, detailCollapsed, terminalCanvasRef]);

  return (
    <div className="project-view">
      {!detailCollapsed && (
        <>
          <DetailPanel
            terminalId={layoutId}
            onSplitHorizontal={() => onSplitPane(splitTarget, "horizontal")}
            onSplitVertical={() => onSplitPane(splitTarget, "vertical")}
            onCollapse={() => setDetailPanelCollapsed(true)}
            style={{ width: detailWidth, minWidth: detailWidth }}
          />
          <div
            className="detail-divider"
            onMouseDown={handleDividerMouseDown}
          />
        </>
      )}
      {detailCollapsed && (
        <button
          className="detail-expand-btn"
          onClick={() => setDetailPanelCollapsed(false)}
          title="Show Notes Panel"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M5 3L9 7L5 11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      )}
      <div className="terminal-canvas" ref={terminalCanvasRef}>
        {isDisconnectedTmuxPlaceholder ? (
          <div className="tmux-placeholder-view">
            <div className="tmux-placeholder-card">
              <div className="tmux-placeholder-label">tmux -CC</div>
              <h2 className="tmux-placeholder-title">Reconnect to hydrate this tab</h2>
              <p className="tmux-placeholder-copy">
                Press <kbd>Cmd</kbd>+<kbd>T</kbd> to open a normal terminal, re-ssh if needed, then run
                <span className="tmux-placeholder-inline-command">tmux -CC a</span>.
                Dispatcher will reconnect and hydrate this saved tmux tab.
              </p>
              <code className="tmux-placeholder-command">tmux -CC a</code>
            </div>
          </div>
        ) : (
          <SplitContainer
            node={layout}
            layoutId={layoutId}
            onSplit={onSplitPane}
            onClose={onClosePane}
            onTmuxPaneDragStart={isTmuxLayout ? beginTmuxPaneResizeByTerminal : undefined}
            onTmuxPaneDragEnd={isTmuxLayout ? handleTmuxPaneDragEnd : undefined}
          />
        )}
      </div>
    </div>
  );
}
