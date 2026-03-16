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
import { useFontStore } from "../stores/useFontStore";
import { useColorSchemeStore } from "../stores/useColorSchemeStore";
import { buildFontFamilyCSS } from "../components/common/FontSettings";
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

const WEBGL_OPT_IN_STORAGE_KEY = "dispatcher.webgl.enabled";

function readWebglEnabledPreference(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(WEBGL_OPT_IN_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

let webglEnabled = readWebglEnabledPreference();

function persistWebglEnabled(enabled: boolean) {
  webglEnabled = enabled;
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(WEBGL_OPT_IN_STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // Ignore storage failures (private mode, disabled storage, etc.).
  }
}

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
// WebGL addon policy:
// - default off (opt-in only via localStorage key dispatcher.webgl.enabled=1)
// - if enabled, disable automatically on first context loss for safety
// ---------------------------------------------------------------------------

const MAX_WEBGL_FAILURES = 3;
const WEBGL_PROBE_MS = 30_000;

/** Per-terminal WebGL failure state. */
const webglFailures = new Map<Terminal, number>();
const webglProbeTimers = new Map<Terminal, ReturnType<typeof setTimeout>>();

function loadWebGLAddon(xterm: Terminal) {
  if (!webglEnabled) return;

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
      // Any context loss means WebGL is unstable on this machine/session.
      // Disable it persistently and stay on the safer canvas renderer.
      persistWebglEnabled(false);
      webglFailures.set(xterm, MAX_WEBGL_FAILURES);
      clearWebGLProbe(xterm);
      xterm.refresh(0, xterm.rows - 1);
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

/** Focus the xterm instance for a given terminal (e.g. after renaming). */
export function focusTerminalInstance(terminalId: string) {
  instances.get(terminalId)?.xterm.focus();
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

      const fontState = useFontStore.getState();
      const xterm = new Terminal({
        cursorBlink: true,
        fontSize: fontState.fontSize,
        fontFamily: buildFontFamilyCSS(fontState.fontFamily),
        fontWeight: fontState.fontWeight,
        fontWeightBold: fontState.fontWeightBold,
        lineHeight: fontState.lineHeight,
        letterSpacing: fontState.letterSpacing,
        theme: useColorSchemeStore.getState().getActiveScheme().terminal,
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

        // DEBUG: trace Ctrl+R through the event pipeline
        if (e.ctrlKey && e.key === "r") {
          console.log("[xterm customKeyHandler] Ctrl+R detected", {
            metaKey: e.metaKey,
            ctrlKey: e.ctrlKey,
            key: e.key,
            code: e.code,
            defaultPrevented: e.defaultPrevented,
          });
        }

        // Cmd+K: clear terminal scrollback
        if (e.metaKey && e.key === "k") {
          e.preventDefault();
          xterm.clear();
          return false;
        }

        // App-level shortcuts — let them bubble to the global handler
        if (e.metaKey && ["t", "T", "n", "d", "w", "f", "u", "r", "b", "=", "-", "0"].includes(e.key)) {
          if (e.ctrlKey && e.key === "r") {
            console.log("[xterm customKeyHandler] Ctrl+R blocked by metaKey shortcut list — returning false");
          }
          return false;
        }
        // Bracket shortcuts: Cmd+]/[ (projects) and Cmd+Shift+]/[ (terminals)
        if (e.metaKey && (e.code === "BracketLeft" || e.code === "BracketRight")) {
          return false;
        }

        if (e.ctrlKey && e.key === "r") {
          console.log("[xterm customKeyHandler] Ctrl+R returning true — xterm will handle");
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

    // Ensure remounted terminals always pick up the latest font settings. Without
    // this, hidden tabs can remount with stale metrics and render incorrectly.
    const currentFont = useFontStore.getState();
    inst.xterm.options.fontSize = currentFont.fontSize;
    inst.xterm.options.fontFamily = buildFontFamilyCSS(currentFont.fontFamily);
    inst.xterm.options.fontWeight = currentFont.fontWeight;
    inst.xterm.options.fontWeightBold = currentFont.fontWeightBold;
    inst.xterm.options.lineHeight = currentFont.lineHeight;
    inst.xterm.options.letterSpacing = currentFont.letterSpacing;

    // Sync terminal theme on remount
    inst.xterm.options.theme = useColorSchemeStore.getState().getActiveScheme().terminal;

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
      // DEBUG: trace Ctrl+R (\x12) through onData
      if (data === "\x12") {
        console.log("[xterm onData] Ctrl+R (\\x12) received — sending to PTY", { terminalId });
      }
      // Any submitted command may change cwd; force a fresh lookup on next spawn.
      if (data.includes("\r")) {
        useTerminalStore.getState().updateCwd(terminalId, undefined);
      }
      writeTerminal(terminalId, data).catch(() => {});
    });

    // Handle resize
    const resizeDisposable = inst.xterm.onResize(({ cols, rows }) => {
      resizeTerminal(terminalId, cols, rows).catch(() => {});
    });

    // Sync all font properties from store whenever they change
    const unsubFont = useFontStore.subscribe((state) => {
      const i = instances.get(terminalId);
      if (i) {
        i.xterm.options.fontSize = state.fontSize;
        i.xterm.options.fontFamily = buildFontFamilyCSS(state.fontFamily);
        i.xterm.options.fontWeight = state.fontWeight;
        i.xterm.options.fontWeightBold = state.fontWeightBold;
        i.xterm.options.lineHeight = state.lineHeight;
        i.xterm.options.letterSpacing = state.letterSpacing;
        cancelAnimationFrame(pendingFitRef.current);
        pendingFitRef.current = requestAnimationFrame(() => {
          i.fitAddon.fit();
        });
      }
    });

    // Sync terminal color scheme whenever the store changes
    const unsubScheme = useColorSchemeStore.subscribe((state) => {
      const i = instances.get(terminalId);
      if (i) {
        i.xterm.options.theme = state.getActiveScheme().terminal;
      }
    });

    return () => {
      cancelAnimationFrame(rafId);
      cancelAnimationFrame(pendingFitRef.current);
      unsubFont();
      unsubScheme();
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
