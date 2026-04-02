import { useEffect, useRef, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Channel } from "@tauri-apps/api/core";
import { readText as readClipboardText, writeText as writeClipboardText } from "@tauri-apps/plugin-clipboard-manager";
import { open } from "@tauri-apps/plugin-shell";
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
import { describeKeyboardEvent, describeTerminalData, pushKeyDebug } from "../lib/keyDebug";

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
  lastWidth: number;
  lastHeight: number;
}

interface SyntheticInputSuppression {
  data: string;
  expiresAt: number;
}

interface FocusSequenceSuppression {
  expiresAt: number;
}

const instances = new Map<string, TerminalInstance>();
const createdPtys = new Set<string>();
const syntheticInputSuppressions = new Map<string, SyntheticInputSuppression>();
const focusSequenceSuppressions = new Map<string, FocusSequenceSuppression>();
const SYNTHETIC_INPUT_SUPPRESSION_MS = 50;
const FOCUS_SEQUENCE_SUPPRESSION_MS = 150;
const DEFAULT_SCROLLBACK = 1_000_000;
const PARKED_TERMINAL_WIDTH = 1200;
const PARKED_TERMINAL_HEIGHT = 720;
const PARKING_ROOT_ID = "dispatcher-terminal-parking-root";

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

function isLinkOpenModifierPressed(event: MouseEvent): boolean {
  const isMac = navigator.platform.startsWith("Mac");
  return isMac ? event.metaKey : event.ctrlKey;
}

function isOptionModifierPressed(event: MouseEvent): boolean {
  return event.altKey;
}

async function pasteClipboardIntoTerminal(terminalId: string, xterm: Terminal) {
  pushKeyDebug(`terminal.middle-paste-request:${terminalId}`, {});

  const text = await readClipboardText();
  if (!text) {
    pushKeyDebug(`terminal.middle-paste-empty:${terminalId}`, {});
    return;
  }

  pushKeyDebug(`terminal.middle-paste-data:${terminalId}`, describeTerminalData(text));
  xterm.focus();
  xterm.paste(text);
}

async function copyTerminalSelectionToClipboard(terminalId: string, xterm: Terminal) {
  const text = xterm.getSelection();
  if (!text) {
    pushKeyDebug(`terminal.selection-copy-empty:${terminalId}`, {});
    return;
  }

  pushKeyDebug(`terminal.selection-copy:${terminalId}`, {
    selectionLength: text.length,
  });
  await writeClipboardText(text);
}

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

function shouldSuppressSyntheticEcho(terminalId: string, data: string): boolean {
  const suppression = syntheticInputSuppressions.get(terminalId);
  if (!suppression) {
    return false;
  }

  if (suppression.expiresAt < Date.now()) {
    syntheticInputSuppressions.delete(terminalId);
    return false;
  }

  if (suppression.data !== data) {
    return false;
  }

  syntheticInputSuppressions.delete(terminalId);
  return true;
}

function shouldSuppressTransientFocusSequence(terminalId: string, data: string): boolean {
  if (data !== "\u001b[I" && data !== "\u001b[O") {
    return false;
  }

  const suppression = focusSequenceSuppressions.get(terminalId);
  if (!suppression) {
    return false;
  }

  if (suppression.expiresAt < Date.now()) {
    focusSequenceSuppressions.delete(terminalId);
    return false;
  }

  return true;
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

function getTerminalParkingRoot(): HTMLDivElement {
  let root = document.getElementById(PARKING_ROOT_ID) as HTMLDivElement | null;
  if (root) {
    return root;
  }

  root = document.createElement("div");
  root.id = PARKING_ROOT_ID;
  root.style.position = "fixed";
  root.style.left = "-20000px";
  root.style.top = "0";
  root.style.width = "1px";
  root.style.height = "1px";
  root.style.pointerEvents = "none";
  root.style.opacity = "0";
  root.style.overflow = "hidden";
  root.style.zIndex = "-1";
  document.body.appendChild(root);
  return root;
}

function parkTerminalInstance(instance: TerminalInstance, width?: number, height?: number) {
  const nextWidth = width && width > 0 ? width : instance.lastWidth || PARKED_TERMINAL_WIDTH;
  const nextHeight = height && height > 0 ? height : instance.lastHeight || PARKED_TERMINAL_HEIGHT;

  instance.lastWidth = nextWidth;
  instance.lastHeight = nextHeight;
  instance.element.style.position = "absolute";
  instance.element.style.left = "0";
  instance.element.style.top = "0";
  instance.element.style.width = `${nextWidth}px`;
  instance.element.style.height = `${nextHeight}px`;
  getTerminalParkingRoot().appendChild(instance.element);
}

function attachTerminalInstance(instance: TerminalInstance, mountPoint: HTMLDivElement) {
  const width = mountPoint.clientWidth;
  const height = mountPoint.clientHeight;
  if (width > 0) {
    instance.lastWidth = width;
  }
  if (height > 0) {
    instance.lastHeight = height;
  }

  instance.element.style.position = "";
  instance.element.style.left = "";
  instance.element.style.top = "";
  instance.element.style.width = "100%";
  instance.element.style.height = "100%";
  mountPoint.appendChild(instance.element);
}

function createTerminalInstance(terminalId: string): TerminalInstance {
  const existing = instances.get(terminalId);
  if (existing) {
    return existing;
  }

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
    macOptionIsMeta: true,
    macOptionClickForcesSelection: true,
    scrollback: DEFAULT_SCROLLBACK,
    allowProposedApi: true,
  });

  const fitAddon = new FitAddon();
  xterm.loadAddon(fitAddon);

  const searchAddon = new SearchAddon();
  xterm.loadAddon(searchAddon);

  const webLinksAddon = new WebLinksAddon((event, uri) => {
    if (!isLinkOpenModifierPressed(event)) {
      return;
    }

    event.preventDefault();
    void open(uri).catch(() => {});
  }, {
    hover: (event, uri) => {
      const target = event.target as HTMLElement | null;
      if (!target) {
        return;
      }

      const isMac = navigator.platform.startsWith("Mac");
      target.title = isMac ? `Cmd-click to open ${uri}` : `Ctrl-click to open ${uri}`;
    },
    leave: (event) => {
      const target = event.target as HTMLElement | null;
      if (target) {
        target.removeAttribute("title");
      }
    },
  });
  xterm.loadAddon(webLinksAddon);

  const instance = {
    xterm,
    fitAddon,
    searchAddon,
    element,
    lastWidth: PARKED_TERMINAL_WIDTH,
    lastHeight: PARKED_TERMINAL_HEIGHT,
  };
  parkTerminalInstance(instance, PARKED_TERMINAL_WIDTH, PARKED_TERMINAL_HEIGHT);
  xterm.open(element);
  fitAddon.fit();
  loadWebGLAddon(xterm);

  xterm.attachCustomKeyEventHandler((e) => {
    pushKeyDebug(`xterm.custom-key:${terminalId}`, describeKeyboardEvent(e));
    if (e.type !== "keydown") return true;
    if (e.defaultPrevented) return false;

    if (e.metaKey && e.key === "k") {
      e.preventDefault();
      xterm.clear();
      return false;
    }

    if (e.metaKey && ["t", "T", "n", "d", "w", "f", "u", "r", "b", "=", "-", "0"].includes(e.key)) {
      return false;
    }
    if (e.metaKey && (e.code === "BracketLeft" || e.code === "BracketRight")) {
      return false;
    }

    return true;
  });

  instances.set(terminalId, instance);
  return instance;
}

function ensureTerminalBackend(terminalId: string, cwd?: string) {
  const instance = createTerminalInstance(terminalId);

  if (!createdPtys.has(terminalId)) {
    createdPtys.add(terminalId);

    const channel = new Channel<TerminalOutputPayload>();
    channel.onmessage = (msg) => {
      batchedWrite(msg.terminal_id, msg.data);
    };

    const cols = instance.xterm.cols || 80;
    const rows = instance.xterm.rows || 24;

    createPty(terminalId, channel, cwd, cols, rows)
      .then(() => {
        warmPool(1).catch(() => {});
      })
      .catch((err) => {
        instance.xterm.write(`\r\nError creating terminal: ${err}\r\n`);
      });
  }

  return instance;
}

function captureCanvasScreenshot(element: HTMLDivElement, fallbackWidth: number, fallbackHeight: number): string | null {
  const canvases = Array.from(element.querySelectorAll("canvas"));
  if (canvases.length === 0) {
    return null;
  }

  const width = canvases.reduce((max, canvas) => Math.max(max, canvas.width), 0) || fallbackWidth;
  const height = canvases.reduce((max, canvas) => Math.max(max, canvas.height), 0) || fallbackHeight;
  if (width <= 0 || height <= 0) {
    return null;
  }

  const composite = document.createElement("canvas");
  composite.width = width;
  composite.height = height;
  const context = composite.getContext("2d");
  if (!context) {
    return null;
  }

  for (const canvas of canvases) {
    context.drawImage(canvas, 0, 0, width, height);
  }

  return composite.toDataURL("image/png");
}

function renderTerminalBufferScreenshot(instance: TerminalInstance): string | null {
  const { xterm } = instance;
  const buffer = xterm.buffer.active;
  const width = Math.max(instance.lastWidth || PARKED_TERMINAL_WIDTH, 320);
  const height = Math.max(instance.lastHeight || PARKED_TERMINAL_HEIGHT, 180);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");
  if (!context) {
    return null;
  }

  const theme = xterm.options.theme ?? {};
  const background = theme.background ?? "#000000";
  const foreground = theme.foreground ?? "#f0f0f0";
  const fontSize = typeof xterm.options.fontSize === "number" ? xterm.options.fontSize : 13;
  const lineHeight = typeof xterm.options.lineHeight === "number" ? xterm.options.lineHeight : 1;
  const fontFamily = typeof xterm.options.fontFamily === "string" ? xterm.options.fontFamily : "Menlo, monospace";

  context.fillStyle = background;
  context.fillRect(0, 0, width, height);

  const cellWidth = width / Math.max(xterm.cols, 1);
  const cellHeight = height / Math.max(xterm.rows, 1);
  const baselineOffset = Math.min(cellHeight - 2, Math.max(fontSize, cellHeight * 0.8));

  context.font = `${fontSize}px ${fontFamily}`;
  context.textBaseline = "alphabetic";
  context.fillStyle = foreground;

  for (let row = 0; row < xterm.rows; row++) {
    const line = buffer.getLine(buffer.viewportY + row);
    const text = line?.translateToString(false) ?? "";
    context.fillText(text, 0, row * cellHeight + baselineOffset * lineHeight);
  }

  return canvas.toDataURL("image/png");
}

/** Focus the xterm instance for a given terminal (e.g. after renaming). */
export function focusTerminalInstance(terminalId: string) {
  instances.get(terminalId)?.xterm.focus();
}

export function captureTerminalScreenshot(terminalId: string): string | null {
  const instance = instances.get(terminalId);
  if (!instance) {
    return null;
  }

  return (
    renderTerminalBufferScreenshot(instance) ??
    captureCanvasScreenshot(instance.element, instance.lastWidth, instance.lastHeight)
  );
}

export function sendSyntheticTerminalInput(terminalId: string, data: string) {
  pushKeyDebug(`terminal.synthetic-input:${terminalId}`, describeTerminalData(data));
  syntheticInputSuppressions.set(terminalId, {
    data,
    expiresAt: Date.now() + SYNTHETIC_INPUT_SUPPRESSION_MS,
  });

  writeTerminal(terminalId, data).catch(() => {
    syntheticInputSuppressions.delete(terminalId);
  });
}

export function suppressTransientFocusSequences(terminalId: string) {
  focusSequenceSuppressions.set(terminalId, {
    expiresAt: Date.now() + FOCUS_SEQUENCE_SUPPRESSION_MS,
  });
}

export function ensureTerminalScreenshotTarget(terminalId: string, cwd?: string) {
  ensureTerminalBackend(terminalId, cwd);
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
  syntheticInputSuppressions.delete(terminalId);
  focusSequenceSuppressions.delete(terminalId);
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

    const inst = ensureTerminalBackend(terminalId, cwd);

    // Attach the persistent element to the current mount point.
    attachTerminalInstance(inst, mountPoint);

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

    const handleMiddleMouseDown = (event: MouseEvent) => {
      if (event.button !== 1 || !isOptionModifierPressed(event)) {
        return;
      }

      pushKeyDebug(`terminal.middle-mousedown:${terminalId}`, {
        button: event.button,
        buttons: event.buttons,
        target: event.target instanceof Element
          ? { tag: event.target.tagName, classes: event.target.className }
          : String(event.target),
      });

      // Prevent browser middle-click behaviors like autoscroll so the click
      // can behave like a terminal paste gesture.
      event.preventDefault();
      event.stopPropagation();
      void pasteClipboardIntoTerminal(terminalId, inst.xterm).catch((error) => {
        pushKeyDebug(`terminal.middle-paste-error:${terminalId}`, {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    };

    let optionSelectionPending = false;

    const handleOptionSelectionMouseDown = (event: MouseEvent) => {
      if (event.button !== 0 || !isOptionModifierPressed(event)) {
        optionSelectionPending = false;
        return;
      }

      optionSelectionPending = true;
      pushKeyDebug(`terminal.option-selection-start:${terminalId}`, {
        detail: event.detail,
      });
    };

    const handleOptionSelectionMouseUp = (event: MouseEvent) => {
      if (event.button !== 0 || !optionSelectionPending) {
        return;
      }

      optionSelectionPending = false;
      window.setTimeout(() => {
        void copyTerminalSelectionToClipboard(terminalId, inst.xterm).catch((error) => {
          pushKeyDebug(`terminal.selection-copy-error:${terminalId}`, {
            message: error instanceof Error ? error.message : String(error),
          });
        });
      }, 0);
    };

    const handleOptionDoubleClick = (event: MouseEvent) => {
      if (event.button !== 0 || !isOptionModifierPressed(event)) {
        return;
      }

      pushKeyDebug(`terminal.option-double-click:${terminalId}`, {
        detail: event.detail,
      });
      window.setTimeout(() => {
        void copyTerminalSelectionToClipboard(terminalId, inst.xterm).catch((error) => {
          pushKeyDebug(`terminal.selection-copy-error:${terminalId}`, {
            message: error instanceof Error ? error.message : String(error),
          });
        });
      }, 0);
    };

    inst.element.addEventListener("mousedown", handleMiddleMouseDown, true);
    inst.element.addEventListener("mousedown", handleOptionSelectionMouseDown, true);
    inst.element.addEventListener("mouseup", handleOptionSelectionMouseUp, true);
    inst.element.addEventListener("dblclick", handleOptionDoubleClick, true);

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

      resizeTerminal(terminalId, i.xterm.cols, i.xterm.rows).catch(() => {});
    });

    // Forward user input to PTY.
    const dataDisposable = inst.xterm.onData((data) => {
      pushKeyDebug(`xterm.onData:${terminalId}`, describeTerminalData(data));
      if (shouldSuppressSyntheticEcho(terminalId, data)) {
        pushKeyDebug(`xterm.synthetic-echo-suppressed:${terminalId}`, describeTerminalData(data));
        return;
      }
      if (shouldSuppressTransientFocusSequence(terminalId, data)) {
        pushKeyDebug(`xterm.focus-sequence-suppressed:${terminalId}`, describeTerminalData(data));
        return;
      }
      // Any submitted command may change cwd; force a fresh lookup on next spawn.
      if (data.includes("\r")) {
        useTerminalStore.getState().updateCwd(terminalId, undefined);
      }
      pushKeyDebug(`pty.write-request:${terminalId}`, describeTerminalData(data));
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

      inst.element.removeEventListener("mousedown", handleMiddleMouseDown, true);
      inst.element.removeEventListener("mousedown", handleOptionSelectionMouseDown, true);
      inst.element.removeEventListener("mouseup", handleOptionSelectionMouseUp, true);
      inst.element.removeEventListener("dblclick", handleOptionDoubleClick, true);

      // Detach the element from the DOM but do NOT dispose the xterm.
      // It will be re-attached if the component remounts (layout change).
      parkTerminalInstance(inst, mountPoint.clientWidth, mountPoint.clientHeight);
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
