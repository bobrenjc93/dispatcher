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
import type { TerminalBackendKind } from "../types/terminal";
import { useFontStore } from "../stores/useFontStore";
import { useColorSchemeStore } from "../stores/useColorSchemeStore";
import { buildFontFamilyCSS } from "../components/common/FontSettings";
import { findLayoutKeyForTerminal } from "../lib/layoutUtils";
import { getTabStatusTerminalIds, type TerminalVisualTextSnapshot } from "../lib/terminalScreenshotHash";
import { useLayoutStore } from "../stores/useLayoutStore";
import { useTerminalStore } from "../stores/useTerminalStore";
import { describeKeyboardEvent, describeTerminalData, pushKeyDebug } from "../lib/keyDebug";
import { debugLog } from "../lib/debugLog";
import { isLinkOpenModifierPressed } from "../lib/terminalMouse";
import { routeTmuxTransportOutput, sendInputToTmuxTerminal, sendPasteToTmuxTerminal } from "../lib/tmuxControl";

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

export interface CapturedTerminalVisualSnapshot extends TerminalVisualTextSnapshot {
  imageDataUrl?: string;
}

interface SyntheticInputSuppression {
  data: string;
  expiresAt: number;
}

interface FocusSequenceSuppression {
  expiresAt: number;
}

interface QueuedTerminalOutputOptions {
  recordActivity?: boolean;
  allowParkedWrite?: boolean;
}

interface TerminalBridgeRuntimeState {
  instances: Map<string, TerminalInstance>;
  createdPtys: Set<string>;
  syntheticInputSuppressions: Map<string, SyntheticInputSuppression>;
  focusSequenceSuppressions: Map<string, FocusSequenceSuppression>;
  writeBuffers: Map<string, string[]>;
  writeBufferAllowParked: Set<string>;
  writeRafs: Map<string, number>;
  writeInFlight: Set<string>;
  writeStatusRecorded: Set<string>;
  webglFailures: Map<Terminal, number>;
  webglProbeTimers: Map<Terminal, ReturnType<typeof setTimeout>>;
}

declare global {
  // eslint-disable-next-line no-var
  var __dispatcherTerminalBridgeRuntimeState: TerminalBridgeRuntimeState | undefined;
}

function getTerminalBridgeRuntimeState(): TerminalBridgeRuntimeState {
  if (globalThis.__dispatcherTerminalBridgeRuntimeState) {
    globalThis.__dispatcherTerminalBridgeRuntimeState.writeStatusRecorded ??= new Set<string>();
    debugLog("terminal.runtime", "reuse", {
      instances: globalThis.__dispatcherTerminalBridgeRuntimeState.instances.size,
      createdPtys: globalThis.__dispatcherTerminalBridgeRuntimeState.createdPtys.size,
      writeBuffers: globalThis.__dispatcherTerminalBridgeRuntimeState.writeBuffers.size,
    });
    globalThis.__dispatcherTerminalBridgeRuntimeState.writeInFlight ??= new Set<string>();
    globalThis.__dispatcherTerminalBridgeRuntimeState.writeBufferAllowParked ??= new Set<string>();
    return globalThis.__dispatcherTerminalBridgeRuntimeState;
  }

  const created: TerminalBridgeRuntimeState = {
    instances: new Map<string, TerminalInstance>(),
    createdPtys: new Set<string>(),
    syntheticInputSuppressions: new Map<string, SyntheticInputSuppression>(),
    focusSequenceSuppressions: new Map<string, FocusSequenceSuppression>(),
    writeBuffers: new Map<string, string[]>(),
    writeBufferAllowParked: new Set<string>(),
    writeRafs: new Map<string, number>(),
    writeInFlight: new Set<string>(),
    writeStatusRecorded: new Set<string>(),
    webglFailures: new Map<Terminal, number>(),
    webglProbeTimers: new Map<Terminal, ReturnType<typeof setTimeout>>(),
  };
  globalThis.__dispatcherTerminalBridgeRuntimeState = created;
  debugLog("terminal.runtime", "initialize", {
    instances: 0,
    createdPtys: 0,
    writeBuffers: 0,
  });
  return created;
}

const terminalBridgeRuntime = getTerminalBridgeRuntimeState();
const instances = terminalBridgeRuntime.instances;
const createdPtys = terminalBridgeRuntime.createdPtys;
const syntheticInputSuppressions = terminalBridgeRuntime.syntheticInputSuppressions;
const focusSequenceSuppressions = terminalBridgeRuntime.focusSequenceSuppressions;
const SYNTHETIC_INPUT_SUPPRESSION_MS = 50;
const FOCUS_SEQUENCE_SUPPRESSION_MS = 150;
const DEFAULT_SCROLLBACK = 50_000;
const PARKED_TERMINAL_WIDTH = 1200;
const PARKED_TERMINAL_HEIGHT = 720;
const PARKING_ROOT_ID = "dispatcher-terminal-parking-root";
const MAX_SCREENSHOT_CAPTURE_DEVICE_PIXELS = 1_500_000;
const SLOW_SCREENSHOT_CAPTURE_MS = 80;

// ---------------------------------------------------------------------------
// Write batching — coalesce PTY output per animation frame so xterm.js
// renders once instead of on every 4096-byte IPC chunk.
// ---------------------------------------------------------------------------

const writeBuffers = terminalBridgeRuntime.writeBuffers;
const writeBufferAllowParked = terminalBridgeRuntime.writeBufferAllowParked;
const writeRafs = terminalBridgeRuntime.writeRafs;
const writeInFlight = terminalBridgeRuntime.writeInFlight;
const writeStatusRecorded = terminalBridgeRuntime.writeStatusRecorded;
const TERMINAL_RESPONSE_QUERY_PATTERN =
  /\x1b(?:\[(?:\??6n|>c|c)|\](?:(?:1[0-2])|4;\d+);\?(?:\x07|\x1b\\))/;

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

function isOptionModifierPressed(event: MouseEvent): boolean {
  return event.altKey;
}

function shouldFitFrontendToViewport(backendKind: TerminalBackendKind | undefined): boolean {
  return backendKind !== "tmux-pane" && backendKind !== "tmux-window";
}

function markPastedTerminalActivity(terminalId: string, text: string) {
  if (text.includes("\n") || text.includes("\r")) {
    useTerminalStore.getState().updateCwd(terminalId, undefined);
  }
  useTerminalStore.getState().markTerminalActivity(terminalId);
  reflectImmediateTabActivity(terminalId);
}

async function pasteTextIntoTerminal(terminalId: string, xterm: Terminal, text: string) {
  pushKeyDebug(`terminal.paste-data:${terminalId}`, describeTerminalData(text));
  xterm.focus();

  const backendKind = useTerminalStore.getState().sessions[terminalId]?.backendKind ?? "local";
  if (backendKind === "tmux-pane") {
    markPastedTerminalActivity(terminalId, text);
    xterm.scrollToBottom();
    await sendPasteToTmuxTerminal(terminalId, text);
    return;
  }

  xterm.paste(text);
}

async function pasteClipboardIntoTerminal(terminalId: string, xterm: Terminal) {
  pushKeyDebug(`terminal.middle-paste-request:${terminalId}`, {});

  const text = await readClipboardText();
  if (!text) {
    pushKeyDebug(`terminal.middle-paste-empty:${terminalId}`, {});
    return;
  }

  await pasteTextIntoTerminal(terminalId, xterm, text);
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

function containsTerminalResponseQuery(data: string): boolean {
  return TERMINAL_RESPONSE_QUERY_PATTERN.test(data);
}

function flushBufferedWrite(terminalId: string) {
  const rafId = writeRafs.get(terminalId);
  if (rafId !== undefined) {
    cancelAnimationFrame(rafId);
    writeRafs.delete(terminalId);
  }

  drainTerminalWriteBuffer(terminalId);
}

function scheduleBufferedWrite(terminalId: string) {
  if (writeRafs.has(terminalId) || writeInFlight.has(terminalId)) {
    return;
  }

  const rafId = requestAnimationFrame(() => {
    writeRafs.delete(terminalId);
    drainTerminalWriteBuffer(terminalId);
  });
  writeRafs.set(terminalId, rafId);
}

function drainTerminalWriteBuffer(terminalId: string) {
  if (writeInFlight.has(terminalId)) {
    return;
  }

  const buf = writeBuffers.get(terminalId);
  if (!buf || buf.length === 0) {
    writeStatusRecorded.delete(terminalId);
    return;
  }

  const combined = buf.join("");
  buf.length = 0;
  const allowParkedWrite = writeBufferAllowParked.delete(terminalId);
  const instance = instances.get(terminalId);
  const xterm = instance?.xterm;
  if (!xterm) {
    writeStatusRecorded.delete(terminalId);
    return;
  }
  if (!allowParkedWrite && shouldSkipParkedTmuxWrite(terminalId, instance)) {
    writeStatusRecorded.delete(terminalId);
    return;
  }

  writeInFlight.add(terminalId);
  xterm.write(combined, () => {
    writeInFlight.delete(terminalId);
    writeStatusRecorded.delete(terminalId);
    if ((writeBuffers.get(terminalId)?.length ?? 0) > 0) {
      scheduleBufferedWrite(terminalId);
    }
  });
}

function batchedWrite(
  terminalId: string,
  data: string,
  options?: QueuedTerminalOutputOptions
) {
  let buffer = writeBuffers.get(terminalId);
  if (!buffer) {
    buffer = [];
    writeBuffers.set(terminalId, buffer);
  }
  buffer.push(data);
  if (options?.allowParkedWrite) {
    writeBufferAllowParked.add(terminalId);
  }

  const shouldRecordOutput =
    options?.recordActivity !== false
    && data.length > 0
    && !isTransientFocusSequence(data)
    && hasTerminalActivityOutput(data)
    && !writeStatusRecorded.has(terminalId);
  if (shouldRecordOutput) {
    writeStatusRecorded.add(terminalId);
    useTerminalStore.getState().markTerminalOutput(terminalId);
    reflectImmediateTabOutput(terminalId);
  }

  if (data.includes("\u001b") && containsTerminalResponseQuery(buffer.join(""))) {
    flushBufferedWrite(terminalId);
    return;
  }

  scheduleBufferedWrite(terminalId);
}

export function queueTerminalOutput(
  terminalId: string,
  data: string,
  options?: QueuedTerminalOutputOptions
) {
  batchedWrite(terminalId, data, options);
}

export function reflectImmediateTabActivity(terminalId: string) {
  const terminalStore = useTerminalStore.getState();
  const layouts = useLayoutStore.getState().layouts;
  const tabRootTerminalId = findLayoutKeyForTerminal(layouts, terminalId) ?? terminalId;
  const statusTerminalIds = getTabStatusTerminalIds(
    layouts,
    tabRootTerminalId,
    new Set(Object.keys(terminalStore.sessions))
  );

  for (const statusTerminalId of statusTerminalIds) {
    terminalStore.setDetectedActivity(statusTerminalId, true);
    terminalStore.setNeedsAttention(statusTerminalId, false);
    terminalStore.setPossiblyDone(statusTerminalId, false);
    terminalStore.setLongInactive(statusTerminalId, false);
  }
}

function reflectImmediateTabOutput(terminalId: string) {
  const terminalStore = useTerminalStore.getState();
  const layouts = useLayoutStore.getState().layouts;
  const tabRootTerminalId = findLayoutKeyForTerminal(layouts, terminalId) ?? terminalId;
  const statusTerminalIds = getTabStatusTerminalIds(
    layouts,
    tabRootTerminalId,
    new Set(Object.keys(terminalStore.sessions))
  );

  for (const statusTerminalId of statusTerminalIds) {
    terminalStore.setDetectedActivity(statusTerminalId, true);
    terminalStore.setPossiblyDone(statusTerminalId, false);
    terminalStore.setLongInactive(statusTerminalId, false);
  }
}

function disposeWriteBatch(terminalId: string) {
  const rafId = writeRafs.get(terminalId);
  if (rafId !== undefined) {
    cancelAnimationFrame(rafId);
    writeRafs.delete(terminalId);
  }
  writeBuffers.delete(terminalId);
  writeBufferAllowParked.delete(terminalId);
  writeInFlight.delete(terminalId);
  writeStatusRecorded.delete(terminalId);
}

function isParkedTerminalInstance(instance: TerminalInstance): boolean {
  return instance.element.parentElement?.id === PARKING_ROOT_ID;
}

function shouldSkipParkedTmuxWrite(terminalId: string, instance: TerminalInstance): boolean {
  const backendKind = useTerminalStore.getState().sessions[terminalId]?.backendKind;
  // Parked tmux panes can be redrawn from tmux on focus; rendering their live
  // output while hidden is pure renderer load.
  return (
    isParkedTerminalInstance(instance)
    && (backendKind === "tmux-pane" || backendKind === "tmux-window")
  );
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

function isTransientFocusSequence(data: string): boolean {
  return data === "\u001b[I" || data === "\u001b[O";
}

function stripTerminalControlSequences(data: string): string {
  return data
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001bP[\s\S]*?\u001b\\/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[()*+#%./-][ -~]?/g, "")
    .replace(/\u001b[@-Z\\-_]/g, "")
    .replace(/[\x00-\x1f\x7f]/g, "");
}

function hasTerminalActivityOutput(data: string): boolean {
  return /[^\s]/.test(stripTerminalControlSequences(data));
}

// ---------------------------------------------------------------------------
// WebGL addon policy:
// - default off (opt-in only via localStorage key dispatcher.webgl.enabled=1)
// - if enabled, disable automatically on first context loss for safety
// ---------------------------------------------------------------------------

const MAX_WEBGL_FAILURES = 3;
const WEBGL_PROBE_MS = 30_000;

/** Per-terminal WebGL failure state. */
const webglFailures = terminalBridgeRuntime.webglFailures;
const webglProbeTimers = terminalBridgeRuntime.webglProbeTimers;

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
    linkHandler: {
      activate: (event, text) => {
        if (!isLinkOpenModifierPressed(event)) {
          return;
        }
        try {
          const url = new URL(text);
          if (url.protocol === "http:" || url.protocol === "https:") {
            event.preventDefault();
            void open(text).catch(() => {});
          }
        } catch {
          // not a valid URL
        }
      },
    },
  });

  const fitAddon = new FitAddon();
  xterm.loadAddon(fitAddon);

  const searchAddon = new SearchAddon();
  xterm.loadAddon(searchAddon);

  const webLinksAddon = new WebLinksAddon((event, uri) => {
    const modifierPressed = isLinkOpenModifierPressed(event);
    const backendKind = useTerminalStore.getState().sessions[terminalId]?.backendKind ?? "local";

    debugLog("terminal.link", "activate", {
      terminalId,
      backendKind,
      uri,
      modifierPressed,
      button: event.button,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      defaultPrevented: event.defaultPrevented,
    });

    if (!modifierPressed) {
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
  const backendKind = useTerminalStore.getState().sessions[terminalId]?.backendKind;
  if (shouldFitFrontendToViewport(backendKind)) {
    fitAddon.fit();
  }
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

export function ensureTerminalFrontend(terminalId: string) {
  createTerminalInstance(terminalId);
}

export function hasTerminalFrontend(terminalId: string): boolean {
  return instances.has(terminalId);
}

function ensureTerminalBackend(terminalId: string, cwd?: string) {
  const instance = createTerminalInstance(terminalId);
  const backendKind = useTerminalStore.getState().sessions[terminalId]?.backendKind ?? "local";

  if (backendKind === "tmux-pane" || backendKind === "tmux-window") {
    return instance;
  }

  if (!createdPtys.has(terminalId)) {
    createdPtys.add(terminalId);

    const channel = new Channel<TerminalOutputPayload>();
    channel.onmessage = (msg) => {
      const nextData = routeTmuxTransportOutput(msg.terminal_id, msg.data);
      if (nextData) {
        batchedWrite(msg.terminal_id, nextData);
      }
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

function parseCssPixelValue(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isTransparentCssColor(value: string | null | undefined): boolean {
  if (!value || value === "transparent") {
    return true;
  }

  const rgbaMatch = /^rgba?\(([^)]+)\)$/.exec(value.trim());
  if (!rgbaMatch) {
    return false;
  }

  const parts = rgbaMatch[1].split(",").map((part) => part.trim());
  if (parts.length < 4) {
    return false;
  }

  const alpha = Number.parseFloat(parts[3]);
  return Number.isFinite(alpha) && alpha <= 0;
}

function getElementCaptureSize(
  element: HTMLElement,
  fallbackWidth: number,
  fallbackHeight: number
): { width: number; height: number; rect: DOMRect } {
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  const width =
    (rect.width > 0 ? rect.width : null)
    ?? parseCssPixelValue(style.width)
    ?? Math.max(fallbackWidth, 1);
  const height =
    (rect.height > 0 ? rect.height : null)
    ?? parseCssPixelValue(style.height)
    ?? Math.max(fallbackHeight, 1);
  return { width, height, rect };
}

function getCanvasCaptureRect(
  canvas: HTMLCanvasElement,
  rootRect: DOMRect
): { left: number; top: number; width: number; height: number } | null {
  if (canvas.width <= 0 || canvas.height <= 0) {
    return null;
  }

  const rect = canvas.getBoundingClientRect();
  const style = window.getComputedStyle(canvas);
  const devicePixelRatio = Math.max(1, window.devicePixelRatio || 1);
  const width =
    (rect.width > 0 ? rect.width : null)
    ?? parseCssPixelValue(style.width)
    ?? (canvas.clientWidth > 0 ? canvas.clientWidth : null)
    ?? canvas.width / devicePixelRatio;
  const height =
    (rect.height > 0 ? rect.height : null)
    ?? parseCssPixelValue(style.height)
    ?? (canvas.clientHeight > 0 ? canvas.clientHeight : null)
    ?? canvas.height / devicePixelRatio;
  if (width <= 0 || height <= 0) {
    return null;
  }

  return {
    left: rect.width > 0 || rect.height > 0
      ? rect.left - rootRect.left
      : parseCssPixelValue(style.left) ?? 0,
    top: rect.width > 0 || rect.height > 0
      ? rect.top - rootRect.top
      : parseCssPixelValue(style.top) ?? 0,
    width,
    height,
  };
}

function getTerminalCanvasBackground(element: HTMLDivElement): string {
  const candidates = [
    element.querySelector(".xterm-screen") as HTMLElement | null,
    element.querySelector(".xterm-viewport") as HTMLElement | null,
    element,
  ];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const color = window.getComputedStyle(candidate).backgroundColor;
    if (!isTransparentCssColor(color)) {
      return color;
    }
  }

  return "#000000";
}

function getScreenshotCaptureScale(width: number, height: number): number {
  const devicePixelRatio = Math.max(1, window.devicePixelRatio || 1);
  const cssPixels = Math.max(1, width * height);
  const maxScale = Math.sqrt(MAX_SCREENSHOT_CAPTURE_DEVICE_PIXELS / cssPixels);
  return Math.max(0.01, Math.min(devicePixelRatio, maxScale));
}

function captureCanvasScreenshot(
  element: HTMLDivElement,
  fallbackWidth: number,
  fallbackHeight: number
): string | null {
  const canvases = Array.from(element.querySelectorAll("canvas")).filter((canvas) => {
    const style = window.getComputedStyle(canvas);
    return (
      canvas.width > 0
      && canvas.height > 0
      && style.display !== "none"
      && style.visibility !== "hidden"
      && Number.parseFloat(style.opacity || "1") > 0
    );
  });
  if (canvases.length === 0) {
    return null;
  }

  const rootSize = getElementCaptureSize(element, fallbackWidth, fallbackHeight);
  const width = rootSize.width;
  const height = rootSize.height;
  if (width <= 0 || height <= 0) {
    return null;
  }

  const captureScale = getScreenshotCaptureScale(width, height);
  const composite = document.createElement("canvas");
  composite.width = Math.max(1, Math.round(width * captureScale));
  composite.height = Math.max(1, Math.round(height * captureScale));
  const context = composite.getContext("2d");
  if (!context) {
    return null;
  }

  context.scale(captureScale, captureScale);
  context.imageSmoothingEnabled = false;
  context.fillStyle = getTerminalCanvasBackground(element);
  context.fillRect(0, 0, width, height);

  const startedAt = performance.now();
  try {
    for (const canvas of canvases) {
      const target = getCanvasCaptureRect(canvas, rootSize.rect);
      if (!target) {
        continue;
      }

      const opacity = Number.parseFloat(window.getComputedStyle(canvas).opacity || "1");
      context.globalAlpha = Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : 1;
      context.drawImage(
        canvas,
        0,
        0,
        canvas.width,
        canvas.height,
        target.left,
        target.top,
        target.width,
        target.height
      );
    }
    context.globalAlpha = 1;
    const dataUrl = composite.toDataURL("image/png");
    const elapsedMs = performance.now() - startedAt;
    if (elapsedMs > SLOW_SCREENSHOT_CAPTURE_MS) {
      debugLog("terminal.screenshot", "slow canvas capture", {
        elapsedMs: Math.round(elapsedMs),
        canvasCount: canvases.length,
        width,
        height,
        captureScale,
        outputWidth: composite.width,
        outputHeight: composite.height,
        encodedBytes: dataUrl.length,
      });
    }
    return dataUrl;
  } catch (error) {
    debugLog("terminal.screenshot", "canvas capture failed", {
      error: error instanceof Error ? error.message : String(error),
      canvasCount: canvases.length,
      width,
      height,
      captureScale,
      outputWidth: composite.width,
      outputHeight: composite.height,
    });
    return null;
  }
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

function readTerminalVisualTextSnapshot(
  terminalId: string,
  instance: TerminalInstance
): TerminalVisualTextSnapshot {
  const { xterm } = instance;
  const buffer = xterm.buffer.active;
  const lines: string[] = [];

  for (let row = 0; row < xterm.rows; row += 1) {
    const line = buffer.getLine(buffer.viewportY + row);
    lines.push(line?.translateToString(false) ?? "");
  }

  return {
    terminalId,
    cols: xterm.cols,
    rows: xterm.rows,
    lines,
  };
}

/** Focus the xterm instance for a given terminal (e.g. after renaming). */
export function focusTerminalInstance(terminalId: string) {
  instances.get(terminalId)?.xterm.focus();
}

export function refreshAllTerminalFrontends(reason: string) {
  const sessions = useTerminalStore.getState().sessions;
  let attached = 0;
  let parked = 0;
  let fit = 0;
  let refreshed = 0;

  for (const [terminalId, instance] of instances) {
    const mountPoint = instance.element.parentElement as HTMLElement | null;
    const isParked = !mountPoint || mountPoint.id === PARKING_ROOT_ID;
    if (isParked) {
      parked += 1;
    } else {
      attached += 1;
      const backendKind = sessions[terminalId]?.backendKind;
      if (shouldFitFrontendToViewport(backendKind)) {
        try {
          instance.fitAddon.fit();
          fit += 1;
        } catch (error) {
          debugLog("terminal.frontend", "wake fit failed", {
            terminalId,
            reason,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    if (instance.xterm.rows > 0) {
      instance.xterm.refresh(0, instance.xterm.rows - 1);
      refreshed += 1;
    }
  }

  debugLog("terminal.frontend", "wake refresh", {
    reason,
    instances: instances.size,
    attached,
    parked,
    fit,
    refreshed,
  });
}

function getTerminalMountContentSize(mountPoint: HTMLElement): { width: number; height: number } {
  const style = window.getComputedStyle(mountPoint);
  const parsedWidth = Number.parseFloat(style.width);
  const parsedHeight = Number.parseFloat(style.height);
  if (
    Number.isFinite(parsedWidth)
    && parsedWidth > 0
    && Number.isFinite(parsedHeight)
    && parsedHeight > 0
  ) {
    return { width: parsedWidth, height: parsedHeight };
  }

  const rect = mountPoint.getBoundingClientRect();
  const paddingX =
    Number.parseFloat(style.paddingLeft || "0")
    + Number.parseFloat(style.paddingRight || "0");
  const paddingY =
    Number.parseFloat(style.paddingTop || "0")
    + Number.parseFloat(style.paddingBottom || "0");
  return {
    width: Math.max(0, rect.width - paddingX),
    height: Math.max(0, rect.height - paddingY),
  };
}

export function syncTerminalFrontendSize(terminalId: string, cols: number, rows: number) {
  const instance = instances.get(terminalId);
  if (!instance) {
    return;
  }

  const nextCols = Math.max(2, Math.floor(cols));
  const nextRows = Math.max(1, Math.floor(rows));
  if (
    !Number.isFinite(nextCols)
    || !Number.isFinite(nextRows)
    || (instance.xterm.cols === nextCols && instance.xterm.rows === nextRows)
  ) {
    return;
  }

  const mountPoint = instance.element.parentElement as HTMLElement | null;
  const dimensions = (instance.xterm as Terminal & {
    _core?: {
      _renderService?: {
        dimensions?: {
          css: {
            cell: {
              width: number;
              height: number;
            };
          };
        };
      };
    };
  })._core?._renderService?.dimensions;
  const viewportSize = mountPoint && mountPoint.id !== PARKING_ROOT_ID
    ? getTerminalMountContentSize(mountPoint)
    : null;
  const viewportWidth = viewportSize?.width ?? null;
  const viewportHeight = viewportSize?.height ?? null;
  const cellWidth = dimensions?.css.cell.width ?? null;
  const cellHeight = dimensions?.css.cell.height ?? null;
  const requiredWidth = cellWidth ? nextCols * cellWidth : null;
  const requiredHeight = cellHeight ? nextRows * cellHeight : null;
  const overflowX = viewportWidth !== null && requiredWidth !== null ? requiredWidth - viewportWidth : null;
  const overflowY = viewportHeight !== null && requiredHeight !== null ? requiredHeight - viewportHeight : null;

  debugLog("terminal.frontend", "resize", {
    terminalId,
    previousCols: instance.xterm.cols,
    previousRows: instance.xterm.rows,
    cols: nextCols,
    rows: nextRows,
    viewportWidth,
    viewportHeight,
    cellWidth,
    cellHeight,
    requiredWidth,
    requiredHeight,
    overflowX,
    overflowY,
  });
  if (overflowX !== null && overflowY !== null && (overflowX > 1 || overflowY > 1)) {
    debugLog("terminal.frontend", "grid exceeds viewport", {
      terminalId,
      cols: nextCols,
      rows: nextRows,
      viewportWidth,
      viewportHeight,
      requiredWidth,
      requiredHeight,
      overflowX,
      overflowY,
    });
  }
  instance.xterm.resize(nextCols, nextRows);
}

export function getTerminalCellSize(terminalId: string): { width: number; height: number } | null {
  const instance = instances.get(terminalId);
  if (!instance) {
    return null;
  }

  const dimensions = (instance.xterm as Terminal & {
    _core?: {
      _renderService?: {
        dimensions?: {
          css: {
            cell: {
              width: number;
              height: number;
            };
          };
        };
      };
    };
  })._core?._renderService?.dimensions;

  const width = dimensions?.css.cell.width ?? 0;
  const height = dimensions?.css.cell.height ?? 0;
  if (width <= 0 || height <= 0) {
    return null;
  }

  return { width, height };
}

export function getTerminalViewportSize(terminalId: string): { width: number; height: number } | null {
  const instance = instances.get(terminalId);
  if (!instance) {
    return null;
  }

  const mountPoint = instance.element.parentElement as HTMLElement | null;
  if (!mountPoint || mountPoint.id === PARKING_ROOT_ID) {
    return null;
  }

  const { width, height } = getTerminalMountContentSize(mountPoint);
  if (width <= 0 || height <= 0) {
    return null;
  }

  return { width, height };
}

export function captureTerminalScreenshot(terminalId: string): string | null {
  const instance = instances.get(terminalId);
  if (!instance) {
    return null;
  }

  return (
    (isParkedTerminalInstance(instance)
      ? null
      : captureCanvasScreenshot(instance.element, instance.lastWidth, instance.lastHeight))
    ?? renderTerminalBufferScreenshot(instance)
  );
}

export function captureTerminalVisualSnapshot(
  terminalId: string,
  options?: { includeScreenshot?: boolean }
): CapturedTerminalVisualSnapshot | null {
  const instance = instances.get(terminalId);
  if (!instance) {
    return null;
  }

  const snapshot = readTerminalVisualTextSnapshot(terminalId, instance);
  if (!options?.includeScreenshot) {
    return snapshot;
  }

  const imageDataUrl = captureTerminalScreenshot(terminalId);
  return imageDataUrl === null ? null : { ...snapshot, imageDataUrl };
}

export function sendSyntheticTerminalInput(terminalId: string, data: string) {
  pushKeyDebug(`terminal.synthetic-input:${terminalId}`, describeTerminalData(data));
  syntheticInputSuppressions.set(terminalId, {
    data,
    expiresAt: Date.now() + SYNTHETIC_INPUT_SUPPRESSION_MS,
  });
  reflectImmediateTabActivity(terminalId);

  // Synthetic control/meta chords bypass xterm's native key handling, so
  // mirror the default scroll-on-user-input behavior before writing to the PTY.
  instances.get(terminalId)?.xterm.scrollToBottom();

  const backendKind = useTerminalStore.getState().sessions[terminalId]?.backendKind ?? "local";
  if (backendKind === "tmux-pane") {
    sendInputToTmuxTerminal(terminalId, data).catch(() => {
      syntheticInputSuppressions.delete(terminalId);
    });
    return;
  }

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

    const handlePaste = (event: ClipboardEvent) => {
      const backendKind = useTerminalStore.getState().sessions[terminalId]?.backendKind ?? "local";
      if (backendKind !== "tmux-pane") {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const text = event.clipboardData?.getData("text/plain");
      if (text !== undefined) {
        if (!text) {
          return;
        }
        void pasteTextIntoTerminal(terminalId, inst.xterm, text).catch((error) => {
          pushKeyDebug(`terminal.paste-error:${terminalId}`, {
            message: error instanceof Error ? error.message : String(error),
          });
        });
        return;
      }

      pushKeyDebug(`terminal.paste-clipboard-fallback:${terminalId}`, {});
      void readClipboardText().then((clipboardText) => {
        if (!clipboardText) {
          pushKeyDebug(`terminal.paste-fallback-empty:${terminalId}`, {});
          return;
        }
        return pasteTextIntoTerminal(terminalId, inst.xterm, clipboardText);
      }).catch((error) => {
        pushKeyDebug(`terminal.paste-fallback-error:${terminalId}`, {
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
    inst.element.addEventListener("paste", handlePaste, true);
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

      const backendKind = useTerminalStore.getState().sessions[terminalId]?.backendKind;
      if (shouldFitFrontendToViewport(backendKind)) {
        i.fitAddon.fit();
      }
      // Only steal DOM focus if this terminal is the active one.
      // Without this guard, every pane calls focus() on mount and
      // the last-rendered pane wins — breaking focus restoration.
      if (useTerminalStore.getState().activeTerminalId === terminalId) {
        i.xterm.focus();
      }

      if (backendKind === "local" || backendKind === "tmux-transport") {
        resizeTerminal(terminalId, i.xterm.cols, i.xterm.rows).catch(() => {});
      }
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
      if (!isTransientFocusSequence(data)) {
        useTerminalStore.getState().markTerminalActivity(terminalId);
        reflectImmediateTabActivity(terminalId);
      }
      pushKeyDebug(`pty.write-request:${terminalId}`, describeTerminalData(data));
      const backendKind = useTerminalStore.getState().sessions[terminalId]?.backendKind ?? "local";
      if (backendKind === "tmux-pane") {
        sendInputToTmuxTerminal(terminalId, data).catch(() => {});
      } else {
        writeTerminal(terminalId, data).catch(() => {});
      }
    });

    // Handle resize
    const resizeDisposable = inst.xterm.onResize(({ cols, rows }) => {
      const backendKind = useTerminalStore.getState().sessions[terminalId]?.backendKind ?? "local";
      if (backendKind === "local" || backendKind === "tmux-transport") {
        resizeTerminal(terminalId, cols, rows).catch(() => {});
      }
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
          const backendKind = useTerminalStore.getState().sessions[terminalId]?.backendKind;
          if (shouldFitFrontendToViewport(backendKind)) {
            i.fitAddon.fit();
            return;
          }
          if (i.xterm.rows > 0) {
            i.xterm.refresh(0, i.xterm.rows - 1);
          }
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
      inst.element.removeEventListener("paste", handlePaste, true);
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
      const backendKind = useTerminalStore.getState().sessions[terminalId]?.backendKind;
      if (!shouldFitFrontendToViewport(backendKind)) {
        return;
      }
      fitAddonRef.current?.fit();
    });
  }, [terminalId]);

  return { containerRef, xtermRef, fitAddonRef, searchAddonRef, fit };
}
