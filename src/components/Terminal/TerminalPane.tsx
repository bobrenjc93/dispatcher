import { useState, useEffect, useCallback, useRef } from "react";
import {
  sendSyntheticTerminalInput,
  suppressTransientFocusSequences,
  type TerminalPasteProgress,
  useTerminalPasteProgress,
  useTerminalBridge,
} from "../../hooks/useTerminalBridge";
import { useResizeObserver } from "../../hooks/useResizeObserver";
import { useTerminalStore } from "../../stores/useTerminalStore";
import { ContextMenu } from "../common/ContextMenu";
import {
  getCtrlLetterControlCharacter,
  getMacDeleteSequence,
  getMacOptionMetaSequence,
  suppressMacCtrlChordTextInput,
} from "../../lib/keyboardShortcuts";
import {
  handleTmuxTerminalFocus,
  syncTmuxWindowSizeFromPaneTerminal,
} from "../../lib/tmuxControl";
import {
  describeInputLikeEvent,
  describeKeyboardEvent,
  describeTerminalData,
  pushKeyDebug,
} from "../../lib/keyDebug";
import { debugLog } from "../../lib/debugLog";
import { shouldSyncTmuxFocusOnMouseDown } from "../../lib/terminalMouse";

interface TerminalPaneProps {
  terminalId: string;
  layoutId: string;
  onSplit?: (terminalId: string, direction: "horizontal" | "vertical") => void;
  onClose?: (terminalId: string) => void;
}

function formatPasteSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.ceil(bytes / 1024)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getPasteProgressLabel(progress: TerminalPasteProgress): string {
  if (progress.phase === "pasting") {
    return "Applying paste";
  }
  if (progress.totalChunks && progress.totalChunks > 1) {
    return `Pasting ${progress.completedChunks}/${progress.totalChunks}`;
  }
  return progress.phase === "preparing" ? "Preparing paste" : "Pasting";
}

function getPasteProgressPercent(progress: TerminalPasteProgress): number {
  if (progress.phase === "pasting") {
    return 100;
  }
  if (!progress.totalChunks || progress.totalChunks <= 0) {
    return 8;
  }
  return Math.max(8, Math.min(96, (progress.completedChunks / progress.totalChunks) * 100));
}

export function TerminalPane({
  terminalId,
  layoutId,
  onSplit,
  onClose,
}: TerminalPaneProps) {
  const cwd = useTerminalStore((s) => s.sessions[terminalId]?.cwd);
  const { containerRef, searchAddonRef, xtermRef, fit } = useTerminalBridge({ terminalId, cwd });
  const pasteProgress = useTerminalPasteProgress(terminalId);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  const syncTmuxPaneViewport = useCallback(() => {
    fit();
    if (syncTmuxWindowSizeFromPaneTerminal(terminalId)) {
      return;
    }
    requestAnimationFrame(() => {
      syncTmuxWindowSizeFromPaneTerminal(terminalId);
    });
  }, [fit, terminalId]);

  const handleResize = useCallback(() => {
    syncTmuxPaneViewport();
  }, [syncTmuxPaneViewport]);

  const resizeRef = useResizeObserver(handleResize);

  // Re-fit on window resize (e.g. maximising/restoring the window).
  useEffect(() => {
    const onResize = () => syncTmuxPaneViewport();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [syncTmuxPaneViewport]);

  // Opening/closing the search bar changes the terminal viewport height.
  // Trigger a fit so rows/cols stay in sync with the actual visible area.
  useEffect(() => {
    const rafId = requestAnimationFrame(() => {
      syncTmuxPaneViewport();
    });
    return () => cancelAnimationFrame(rafId);
  }, [searchOpen, syncTmuxPaneViewport]);

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    setTimeout(() => searchInputRef.current?.focus(), 0);
  }, []);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
    searchAddonRef.current?.clearDecorations();
    xtermRef.current?.focus();
  }, [searchAddonRef, xtermRef]);

  const scheduleMacTextInputSuppressionCleanup = useCallback((cleanup: () => void) => {
    // Use the next macrotask, not the next animation frame, so fast tmux
    // prefix sequences like Option+Q, C do not lose the second key.
    setTimeout(cleanup, 0);
  }, []);

  const resetMacOptionCompositionState = useCallback((eventTarget: EventTarget | null) => {
    const helperTextarea = eventTarget instanceof HTMLTextAreaElement ? eventTarget : null;
    if (helperTextarea) {
      helperTextarea.value = "";
      try {
        helperTextarea.setSelectionRange(0, 0);
      } catch {
        // Ignore selection reset failures on hidden helper textareas.
      }
    }

    pushKeyDebug(`terminal.meta-reset:${terminalId}`, {
      hadHelperTextarea: helperTextarea !== null,
    });
    suppressTransientFocusSequences(terminalId);
  }, [terminalId]);

  const doSearch = useCallback(
    (query: string, direction: "next" | "prev" = "next") => {
      if (!query) {
        searchAddonRef.current?.clearDecorations();
        return;
      }
      if (direction === "next") {
        searchAddonRef.current?.findNext(query);
      } else {
        searchAddonRef.current?.findPrevious(query);
      }
    },
    [searchAddonRef]
  );

  // Intercept Cmd+F / Escape on the pane, and forward Ctrl+letter
  // combinations that macOS WKWebView swallows before xterm.js can
  // process them.  Uses capture phase so it fires before xterm.
  useEffect(() => {
    const el = resizeRef.current;
    if (!el) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      pushKeyDebug(`terminal.capture:${terminalId}`, describeKeyboardEvent(e));

      // Use Cmd on macOS, Ctrl on other platforms for search
      const isMac = navigator.platform.startsWith("Mac");
      const searchMod = isMac ? e.metaKey : e.ctrlKey;
      if (searchMod && e.key === "f") {
        e.preventDefault();
        e.stopPropagation();
        openSearch();
        return;
      }
      if (e.key === "Escape" && searchOpen) {
        closeSearch();
        return;
      }
      // On macOS WKWebView, the Cocoa text input system swallows
      // Ctrl+letter keydown events before xterm.js can process them.
      // Intercept in capture phase and inject the control character
      // through xterm's paste() so it flows through the normal
      // onData → writeTerminal pipeline (the same path as typing).
      // Use e.code (physical key) instead of e.key because Cocoa may
      // transform e.key for certain Ctrl combinations (e.g. Ctrl+O
      // becomes "insert newline" and e.key is no longer "o").
      if (isMac) {
        const deleteSequence = getMacDeleteSequence(e);
        if (deleteSequence) {
          pushKeyDebug(`terminal.delete-sequence:${terminalId}`, {
            event: describeKeyboardEvent(e),
            data: describeTerminalData(deleteSequence),
          });
          if (e.repeat) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            const cleanupSuppression = suppressMacCtrlChordTextInput(e.target, document);
            scheduleMacTextInputSuppressionCleanup(cleanupSuppression);
            return;
          }
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          const cleanupSuppression = suppressMacCtrlChordTextInput(e.target, document);
          scheduleMacTextInputSuppressionCleanup(cleanupSuppression);
          sendSyntheticTerminalInput(terminalId, deleteSequence);
          return;
        }

        const controlChar = getCtrlLetterControlCharacter(e);
        if (controlChar) {
          pushKeyDebug(`terminal.ctrl-sequence:${terminalId}`, {
            event: describeKeyboardEvent(e),
            data: describeTerminalData(controlChar),
          });
          if (e.repeat) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            const cleanupSuppression = suppressMacCtrlChordTextInput(e.target, document);
            scheduleMacTextInputSuppressionCleanup(cleanupSuppression);
            return;
          }
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          // WebKit may still emit a text-input action after keydown
          // (notably Ctrl+O -> insertNewline:). Block the immediate
          // follow-up input events so only the control byte lands.
          const cleanupSuppression = suppressMacCtrlChordTextInput(e.target, document);
          scheduleMacTextInputSuppressionCleanup(cleanupSuppression);
          sendSyntheticTerminalInput(terminalId, controlChar);
          return;
        }

        const metaSequence = getMacOptionMetaSequence(e);
        if (metaSequence) {
          pushKeyDebug(`terminal.meta-sequence:${terminalId}`, {
            event: describeKeyboardEvent(e),
            data: describeTerminalData(metaSequence),
          });
          if (e.repeat) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            const cleanupSuppression = suppressMacCtrlChordTextInput(e.target, document);
            scheduleMacTextInputSuppressionCleanup(cleanupSuppression);
            return;
          }
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          const cleanupSuppression = suppressMacCtrlChordTextInput(e.target, document);
          scheduleMacTextInputSuppressionCleanup(cleanupSuppression);
          sendSyntheticTerminalInput(terminalId, metaSequence);
          resetMacOptionCompositionState(e.target);
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      pushKeyDebug(`terminal.keyup:${terminalId}`, describeKeyboardEvent(e));
    };

    const handleInputLikeEvent = (e: Event) => {
      pushKeyDebug(`terminal.${e.type}:${terminalId}`, describeInputLikeEvent(e));
    };

    el.addEventListener("keydown", handleKeyDown, true);
    el.addEventListener("keyup", handleKeyUp, true);
    el.addEventListener("beforeinput", handleInputLikeEvent, true);
    el.addEventListener("input", handleInputLikeEvent, true);
    el.addEventListener("textInput", handleInputLikeEvent, true);
    el.addEventListener("keypress", handleInputLikeEvent, true);
    return () => {
      el.removeEventListener("keydown", handleKeyDown, true);
      el.removeEventListener("keyup", handleKeyUp, true);
      el.removeEventListener("beforeinput", handleInputLikeEvent, true);
      el.removeEventListener("input", handleInputLikeEvent, true);
      el.removeEventListener("textInput", handleInputLikeEvent, true);
      el.removeEventListener("keypress", handleInputLikeEvent, true);
    };
  }, [openSearch, closeSearch, resetMacOptionCompositionState, scheduleMacTextInputSuppressionCleanup, searchOpen, resizeRef, xtermRef]);

  const setActiveTerminal = useTerminalStore((s) => s.setActiveTerminal);
  const isActive = useTerminalStore((s) => s.activeTerminalId === terminalId);

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  return (
    <div
      className={`terminal-pane ${isActive ? "terminal-pane-active" : ""}`}
      data-terminal-id={terminalId}
      ref={resizeRef}
      onMouseDown={(event) => {
        setActiveTerminal(terminalId);
        if (!shouldSyncTmuxFocusOnMouseDown(event.nativeEvent)) {
          debugLog("tmux.focus", "skip sync for mouse gesture", {
            terminalId,
            button: event.button,
            metaKey: event.metaKey,
            ctrlKey: event.ctrlKey,
          });
          return;
        }

        handleTmuxTerminalFocus(terminalId);
      }}
      onContextMenu={handleContextMenu}
    >
      {searchOpen && (
        <div className="terminal-search-bar">
          <input
            ref={searchInputRef}
            className="terminal-search-input"
            value={searchQuery}
            placeholder="Search..."
            onChange={(e) => {
              setSearchQuery(e.target.value);
              doSearch(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                doSearch(searchQuery, e.shiftKey ? "prev" : "next");
              }
              if (e.key === "Escape") {
                closeSearch();
              }
              e.stopPropagation();
            }}
          />
          <button
            className="terminal-search-btn"
            onClick={() => doSearch(searchQuery, "prev")}
            title="Previous (Shift+Enter)"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M2 8L6 4L10 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          <button
            className="terminal-search-btn"
            onClick={() => doSearch(searchQuery, "next")}
            title="Next (Enter)"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M2 4L6 8L10 4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          <button
            className="terminal-search-btn"
            onClick={closeSearch}
            title="Close (Esc)"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M3 3L9 9M9 3L3 9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
      )}
      <div className="terminal-container" ref={containerRef} />
      {pasteProgress && (
        <div className="terminal-paste-progress" role="status" aria-live="polite">
          <div className="terminal-paste-progress-row">
            <span>{getPasteProgressLabel(pasteProgress)}</span>
            <span>{formatPasteSize(pasteProgress.totalBytes)}</span>
          </div>
          <div className="terminal-paste-progress-track">
            <div
              className="terminal-paste-progress-bar"
              style={{ width: `${getPasteProgressPercent(pasteProgress)}%` }}
            />
          </div>
        </div>
      )}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          items={[
            { label: "Split Right", shortcut: "⌘D", onClick: () => onSplit?.(terminalId, "horizontal") },
            { label: "Split Down", shortcut: "⇧⌘D", onClick: () => onSplit?.(terminalId, "vertical") },
            { label: "Close Pane", shortcut: "⌘W", onClick: () => onClose?.(terminalId), danger: true },
          ]}
        />
      )}
    </div>
  );
}
