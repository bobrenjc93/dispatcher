import { useEffect, useRef, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import { Channel } from "@tauri-apps/api/core";
import {
  createTerminal as createPty,
  writeTerminal,
  resizeTerminal,
  warmPool,
} from "../lib/tauriCommands";
import type { TerminalOutputPayload } from "../lib/tauriCommands";
import { useFontSizeStore } from "../stores/useFontSizeStore";
import { useTerminalStore } from "../stores/useTerminalStore";

// ---------------------------------------------------------------------------
// Persistent terminal instances — survive React remounts caused by layout
// tree restructuring (e.g. closing a sibling pane).
// ---------------------------------------------------------------------------

interface TerminalInstance {
  xterm: Terminal;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
  /** The DOM element xterm is rendered into. We move this between mount points. */
  element: HTMLDivElement;
}

const instances = new Map<string, TerminalInstance>();
const createdPtys = new Set<string>();

// ---------------------------------------------------------------------------
// Write batching — coalesce PTY output per animation frame so xterm.js
// renders once instead of on every 4096-byte IPC chunk.
// ---------------------------------------------------------------------------

const writeBuffers = new Map<string, string[]>();
const writeRafs = new Map<string, number>();

function batchedWrite(terminalId: string, data: string) {
  let buffer = writeBuffers.get(terminalId);
  if (!buffer) {
    buffer = [];
    writeBuffers.set(terminalId, buffer);
  }
  buffer.push(data);

  if (!writeRafs.has(terminalId)) {
    const rafId = requestAnimationFrame(() => {
      writeRafs.delete(terminalId);
      const buf = writeBuffers.get(terminalId);
      if (buf && buf.length > 0) {
        const combined = buf.join("");
        buf.length = 0;
        instances.get(terminalId)?.xterm.write(combined);
      }
    });
    writeRafs.set(terminalId, rafId);
  }
}

function disposeWriteBatch(terminalId: string) {
  const rafId = writeRafs.get(terminalId);
  if (rafId !== undefined) {
    cancelAnimationFrame(rafId);
    writeRafs.delete(terminalId);
  }
  writeBuffers.delete(terminalId);
}

// ---------------------------------------------------------------------------
// WebGL addon — load with automatic recovery on context loss.
//
// High-throughput programs (e.g. Claude Code) can cause repeated WebGL context
// losses.  After MAX_WEBGL_FAILURES consecutive failures we stop retrying and
// stay on the canvas renderer.  A periodic probe re-attempts WebGL later so
// transient GPU pressure doesn't permanently disable hardware acceleration.
// ---------------------------------------------------------------------------

const MAX_WEBGL_FAILURES = 3;
const WEBGL_RETRY_MS = 1000;
const WEBGL_PROBE_MS = 30_000;

/** Per-terminal WebGL failure state. */
const webglFailures = new Map<Terminal, number>();
const webglProbeTimers = new Map<Terminal, ReturnType<typeof setTimeout>>();

function loadWebGLAddon(xterm: Terminal) {
  const failures = webglFailures.get(xterm) ?? 0;

  if (failures >= MAX_WEBGL_FAILURES) {
    // Stay on canvas for now; schedule a probe to retry later.
    scheduleWebGLProbe(xterm);
    return;
  }

  try {
    const addon = new WebglAddon();
    addon.onContextLoss(() => {
      addon.dispose();
      webglFailures.set(xterm, (webglFailures.get(xterm) ?? 0) + 1);
      setTimeout(() => {
        loadWebGLAddon(xterm);
        // Repaint all rows so any corruption from the lost context is cleared.
        xterm.refresh(0, xterm.rows - 1);
      }, WEBGL_RETRY_MS);
    });
    xterm.loadAddon(addon);
    // Successful load — reset failure counter and cancel any pending probe.
    webglFailures.set(xterm, 0);
    clearWebGLProbe(xterm);
  } catch {
    webglFailures.set(xterm, failures + 1);
    if (failures + 1 >= MAX_WEBGL_FAILURES) {
      scheduleWebGLProbe(xterm);
    }
  }
}

function scheduleWebGLProbe(xterm: Terminal) {
  if (webglProbeTimers.has(xterm)) return;
  const timer = setTimeout(() => {
    webglProbeTimers.delete(xterm);
    // Reset counter so the probe gets a fresh set of attempts.
    webglFailures.set(xterm, 0);
    loadWebGLAddon(xterm);
  }, WEBGL_PROBE_MS);
  webglProbeTimers.set(xterm, timer);
}

function clearWebGLProbe(xterm: Terminal) {
  const timer = webglProbeTimers.get(xterm);
  if (timer !== undefined) {
    clearTimeout(timer);
    webglProbeTimers.delete(xterm);
  }
}

function cleanupWebGLState(xterm: Terminal) {
  webglFailures.delete(xterm);
  clearWebGLProbe(xterm);
}

/** Dispose an xterm instance and its PTY tracking when a terminal is truly closed. */
export function disposeTerminalInstance(terminalId: string) {
  const inst = instances.get(terminalId);
  if (inst) {
    cleanupWebGLState(inst.xterm);
    inst.xterm.dispose();
    instances.delete(terminalId);
  }
  createdPtys.delete(terminalId);
  disposeWriteBatch(terminalId);
}

// ---------------------------------------------------------------------------

interface UseTerminalBridgeOptions {
  terminalId: string;
  cwd?: string;
}

export function useTerminalBridge({ terminalId, cwd }: UseTerminalBridgeOptions) {
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const pendingFitRef = useRef<number>(0);

  useEffect(() => {
    const mountPoint = containerRef.current;
    if (!mountPoint) return;

    // Re-use an existing instance or create a fresh one.
    let inst = instances.get(terminalId);

    if (!inst) {
      const element = document.createElement("div");
      element.style.width = "100%";
      element.style.height = "100%";

      const xterm = new Terminal({
        cursorBlink: true,
        fontSize: useFontSizeStore.getState().fontSize,
        fontFamily: "'Menlo', 'Monaco', 'Courier New', monospace",
        theme: {
          background: "#0a0a0a",
          foreground: "#ededed",
          cursor: "#ffffff",
          selectionBackground: "#333333",
          black: "#000000",
          red: "#ff3333",
          green: "#00c853",
          yellow: "#ffcc00",
          blue: "#0070f3",
          magenta: "#a855f7",
          cyan: "#06b6d4",
          white: "#ededed",
          brightBlack: "#666666",
          brightRed: "#ff5555",
          brightGreen: "#50fa7b",
          brightYellow: "#f1fa8c",
          brightBlue: "#6cb6ff",
          brightMagenta: "#d183e8",
          brightCyan: "#8be9fd",
          brightWhite: "#ffffff",
        },
        scrollback: 10000,
        allowProposedApi: true,
      });

      const fitAddon = new FitAddon();
      xterm.loadAddon(fitAddon);

      const searchAddon = new SearchAddon();
      xterm.loadAddon(searchAddon);

      xterm.open(element);

      // Try WebGL with automatic recovery on context loss
      loadWebGLAddon(xterm);

      // Handle Cmd+key shortcuts that xterm.js ignores by default
      xterm.attachCustomKeyEventHandler((e) => {
        if (e.type !== "keydown") return true;

        // Cmd+K: clear terminal scrollback
        if (e.metaKey && e.key === "k") {
          e.preventDefault();
          xterm.clear();
          return false;
        }

        // App-level shortcuts — let them bubble to the global handler
        if (e.metaKey && ["t", "n", "d", "w", "f", "u", "=", "-", "0"].includes(e.key)) {
          return false;
        }
        // Cycle terminals: Cmd+Shift+[ / Cmd+Shift+]
        if (e.metaKey && e.shiftKey && (e.code === "BracketLeft" || e.code === "BracketRight")) {
          return false;
        }

        return true;
      });

      inst = { xterm, fitAddon, searchAddon, element };
      instances.set(terminalId, inst);
    }

    // Attach the persistent element to the current mount point.
    mountPoint.appendChild(inst.element);

    xtermRef.current = inst.xterm;
    fitAddonRef.current = inst.fitAddon;
    searchAddonRef.current = inst.searchAddon;

    // Defer fit() to the next animation frame so the browser has laid out the
    // container and fit() can measure accurate dimensions.  Without this, the
    // container may report 0/stale size right after appendChild, causing the
    // PTY to be created with wrong cols/rows — which leads to garbled output
    // whenever the running program uses cursor positioning (e.g. Claude Code).
    const rafId = requestAnimationFrame(() => {
      const i = instances.get(terminalId);
      if (!i) return;

      i.fitAddon.fit();
      // Only steal DOM focus if this terminal is the active one.
      // Without this guard, every pane calls focus() on mount and
      // the last-rendered pane wins — breaking focus restoration.
      if (useTerminalStore.getState().activeTerminalId === terminalId) {
        i.xterm.focus();
      }

      // Create the backend PTY exactly once per terminalId.
      if (!createdPtys.has(terminalId)) {
        createdPtys.add(terminalId);

        const channel = new Channel<TerminalOutputPayload>();
        channel.onmessage = (msg) => {
          batchedWrite(msg.terminal_id, msg.data);
        };

        const cols = i.xterm.cols;
        const rows = i.xterm.rows;

        createPty(terminalId, channel, cwd, cols, rows)
          .then(() => {
            warmPool(1).catch(() => {});
          })
          .catch((err) => {
            i.xterm.write(`\r\nError creating terminal: ${err}\r\n`);
          });
      }
    });

    // Forward user input to PTY.
    const dataDisposable = inst.xterm.onData((data) => {
      writeTerminal(terminalId, data).catch(() => {});
      window.dispatchEvent(new CustomEvent("terminal-typed", { detail: terminalId }));
    });

    // Handle resize
    const resizeDisposable = inst.xterm.onResize(({ cols, rows }) => {
      resizeTerminal(terminalId, cols, rows).catch(() => {});
    });

    // Sync font size from store whenever it changes
    const unsubFontSize = useFontSizeStore.subscribe((state) => {
      const i = instances.get(terminalId);
      if (i) {
        i.xterm.options.fontSize = state.fontSize;
        cancelAnimationFrame(pendingFitRef.current);
        pendingFitRef.current = requestAnimationFrame(() => {
          i.fitAddon.fit();
        });
      }
    });

    return () => {
      cancelAnimationFrame(rafId);
      cancelAnimationFrame(pendingFitRef.current);
      unsubFontSize();
      dataDisposable.dispose();
      resizeDisposable.dispose();

      xtermRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;

      // Detach the element from the DOM but do NOT dispose the xterm.
      // It will be re-attached if the component remounts (layout change).
      if (mountPoint.contains(inst!.element)) {
        mountPoint.removeChild(inst!.element);
      }
    };
  }, [terminalId]); // cwd intentionally omitted — only used for initial PTY creation

  // Debounced fit — coalesces rapid resize events (from ResizeObserver during
  // window/split-pane drag) into a single fit() per animation frame.
  const fit = useCallback(() => {
    cancelAnimationFrame(pendingFitRef.current);
    pendingFitRef.current = requestAnimationFrame(() => {
      fitAddonRef.current?.fit();
    });
  }, []);

  return { containerRef, xtermRef, fitAddonRef, searchAddonRef, fit };
}
