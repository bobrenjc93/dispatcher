import { useEffect, useRef, useCallback, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
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
import { useUiStore } from "../stores/useUiStore";
import { useColorSchemeStore } from "../stores/useColorSchemeStore";
import { buildFontFamilyCSS } from "../components/common/FontSettings";
import { findLayoutKeyForTerminal } from "../lib/layoutUtils";
import { getTabStatusTerminalIds, type TerminalVisualTextSnapshot } from "../lib/terminalScreenshotHash";
import { useLayoutStore } from "../stores/useLayoutStore";
import { useTerminalStore } from "../stores/useTerminalStore";
import { describeKeyboardEvent, describeTerminalData, pushKeyDebug } from "../lib/keyDebug";
import { toControlCharacter } from "../lib/keyboardShortcuts";
import { resolveDictationInput, type DictationState } from "../lib/dictationInput";
import {
  cellFromPoint,
  movedTooFarForLongPress,
  selectionFromCells,
  wordRangeAt,
  LONG_PRESS_MS,
  type TerminalCell,
} from "../lib/terminalTouchSelection";
import { debugLog } from "../lib/debugLog";
import { getScopedStorageKey } from "../lib/storageNamespace";
import {
  forgetMirroredTerminal,
  isPrimaryClient,
  isReplicaClient,
  mirrorTerminalOutput,
  mirrorTerminalSize,
  performAction,
  registerActionHandler,
  setTerminalGridProvider,
} from "../lib/replication";
import { isCompactViewport } from "./useCompactViewport";
import {
  disposeAttachWatchdog,
  noteTerminalInput,
  noteTerminalOutput,
} from "../lib/tmuxAttachWatchdog";
import { recordPaneOutput, recordSessionEvent } from "../lib/sessionRecorder";
import { isLinkOpenModifierPressed, isTouchPointer, shouldOpenLink } from "../lib/terminalMouse";
import { findTerminalWebLinkMatches } from "../lib/terminalLinks";
import {
  getActiveStatusResizeSuppression,
  markStatusResizeSuppression,
} from "../lib/statusResizeSuppression";
import {
  clearTmuxTerminal,
  getCurrentTmuxTransportOutputRouter,
  sendInputToTmuxTerminal,
  sendPasteToTmuxTerminal,
  syncTmuxWindowSizeFromPaneTerminal,
  type TmuxPasteProgress,
} from "../lib/tmuxControl";

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
  /**
   * Authoritative tmux captures already represent the pane state at a point in
   * the tmux event stream. If ordinary output is still waiting in our RAF
   * buffer, replaying it before the capture can briefly show stale/interleaved
   * frames. A capture with this flag replaces pending buffered writes; output
   * that arrives after the capture remains queued after it.
   */
  replaceBufferedOutput?: boolean;
  /**
   * CSI 3J is part of the replay string, but xterm exposes a native clear()
   * that is more reliable when the parser is mid-frame or a previous large
   * write is still draining. Use this only for full history replays where
   * clearing scrollback is intentional.
   */
  clearScrollbackBeforeWrite?: boolean;
}

type SkippedTmuxWriteReason = "parked" | "missing-frontend";

interface ParkedTmuxWriteDropSummary {
  chunks: number;
  bytes: number;
  lastLoggedAt: number;
  reason: SkippedTmuxWriteReason;
}

interface TerminalBridgeRuntimeState {
  instances: Map<string, TerminalInstance>;
  createdPtys: Set<string>;
  syntheticInputSuppressions: Map<string, SyntheticInputSuppression>;
  focusSequenceSuppressions: Map<string, FocusSequenceSuppression>;
  writeBuffers: Map<string, string[]>;
  writeBufferAllowParked: Set<string>;
  writeBufferClearScrollback: Set<string>;
  writeRafs: Map<string, number>;
  writeTimeouts: Map<string, ReturnType<typeof setTimeout>>;
  writeInFlight: Set<string>;
  writeStatusRecorded: Set<string>;
  parkedTmuxWriteDrops: Map<string, ParkedTmuxWriteDropSummary>;
  parkedTmuxActivityLastRecordedAt: Map<string, number>;
  webglFailures: Map<Terminal, number>;
  webglProbeTimers: Map<Terminal, ReturnType<typeof setTimeout>>;
  pasteProgressByTerminal: Map<string, TerminalPasteProgress>;
}

export interface TerminalPasteProgress {
  terminalId: string;
  phase: TmuxPasteProgress["phase"];
  completedChunks: number;
  totalChunks: number | null;
  totalBytes: number;
  startedAt: number;
  updatedAt: number;
}

type TerminalInputRouter = (terminalId: string, data: string) => void;

declare global {
  // eslint-disable-next-line no-var
  var __dispatcherTerminalBridgeRuntimeState: TerminalBridgeRuntimeState | undefined;
  // eslint-disable-next-line no-var
  var __dispatcherTerminalInputRouter: TerminalInputRouter | undefined;
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
    globalThis.__dispatcherTerminalBridgeRuntimeState.writeBufferClearScrollback ??= new Set<string>();
    globalThis.__dispatcherTerminalBridgeRuntimeState.writeTimeouts ??= new Map<string, ReturnType<typeof setTimeout>>();
    globalThis.__dispatcherTerminalBridgeRuntimeState.parkedTmuxWriteDrops ??= new Map<string, ParkedTmuxWriteDropSummary>();
    globalThis.__dispatcherTerminalBridgeRuntimeState.parkedTmuxActivityLastRecordedAt ??= new Map<string, number>();
    globalThis.__dispatcherTerminalBridgeRuntimeState.pasteProgressByTerminal ??= new Map<string, TerminalPasteProgress>();
    return globalThis.__dispatcherTerminalBridgeRuntimeState;
  }

  const created: TerminalBridgeRuntimeState = {
    instances: new Map<string, TerminalInstance>(),
    createdPtys: new Set<string>(),
    syntheticInputSuppressions: new Map<string, SyntheticInputSuppression>(),
    focusSequenceSuppressions: new Map<string, FocusSequenceSuppression>(),
    writeBuffers: new Map<string, string[]>(),
    writeBufferAllowParked: new Set<string>(),
    writeBufferClearScrollback: new Set<string>(),
    writeRafs: new Map<string, number>(),
    writeTimeouts: new Map<string, ReturnType<typeof setTimeout>>(),
    writeInFlight: new Set<string>(),
    writeStatusRecorded: new Set<string>(),
    parkedTmuxWriteDrops: new Map<string, ParkedTmuxWriteDropSummary>(),
    parkedTmuxActivityLastRecordedAt: new Map<string, number>(),
    webglFailures: new Map<Terminal, number>(),
    webglProbeTimers: new Map<Terminal, ReturnType<typeof setTimeout>>(),
    pasteProgressByTerminal: new Map<string, TerminalPasteProgress>(),
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
const writeBufferClearScrollback = terminalBridgeRuntime.writeBufferClearScrollback;
const writeRafs = terminalBridgeRuntime.writeRafs;
const writeTimeouts = terminalBridgeRuntime.writeTimeouts;
const writeInFlight = terminalBridgeRuntime.writeInFlight;
const writeStatusRecorded = terminalBridgeRuntime.writeStatusRecorded;
const parkedTmuxWriteDrops = terminalBridgeRuntime.parkedTmuxWriteDrops;
const parkedTmuxActivityLastRecordedAt = terminalBridgeRuntime.parkedTmuxActivityLastRecordedAt;
const pasteProgressByTerminal = terminalBridgeRuntime.pasteProgressByTerminal;
const TERMINAL_PASTE_PROGRESS_EVENT = "dispatcher:terminal-paste-progress";
const TERMINAL_RESPONSE_QUERY_PATTERN =
  /\x1b(?:\[(?:\??6n|>c|c)|\](?:(?:1[0-2])|4;\d+);\?(?:\x07|\x1b\\))/;
// xterm.js reports terminal-generated answers through onData, the same channel
// it uses for real keystrokes. For a direct local PTY that is correct: programs
// like vim can ask ESC[6n and receive a cursor-position reply. A tmux control
// pane is different. Our xterm instance is a passive renderer of tmux %output
// and capture replays, so feeding these renderer answers back through tmux
// send-keys can inject stale OSC/DSR bytes into whatever app is foregrounded.
// Keep this allowlist narrow: strip only well-known replies xterm itself emits.
const TERMINAL_RESPONSE_SEQUENCE_PATTERN =
  /\x1b(?:\](?:(?:1[0-2])|4;\d+);[^\x07\x1b]*(?:\x07|\x1b\\)|\[\d+;\d+R|\[\?\d+(?:;\d+)*c|\[>\d+(?:;\d+)*c)/g;
const HIDDEN_WRITE_FALLBACK_MS = 50;
/**
 * Ceiling on output waiting to be written into one terminal. Reached only when
 * the frontend has stopped draining; past it the oldest output is discarded.
 */
const MAX_BUFFERED_WRITE_BYTES = 8 * 1024 * 1024;
// Longest terminal-response query we detect is ~10 chars; keep a little slack
// for sequences split across IPC chunk boundaries.
const RESPONSE_QUERY_BOUNDARY_TAIL_CHARS = 16;
const PARKED_TMUX_DROP_SUMMARY_INTERVAL_MS = 5_000;
const PARKED_TMUX_ACTIVITY_THROTTLE_MS = 1_000;
const LARGE_WRITE_DRAIN_BYTES = 1_000_000;
const SLOW_WRITE_DRAIN_MS = 100;

const WEBGL_OPT_IN_STORAGE_KEY = getScopedStorageKey("dispatcher.webgl.enabled");

function getCurrentTerminalInputRouter(): TerminalInputRouter {
  return globalThis.__dispatcherTerminalInputRouter ?? handleTerminalInputData;
}

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
  // A replica renders the grid the desktop window dictates; fitting to its own
  // viewport would fight the mirrored size.
  if (isReplicaClient()) {
    return false;
  }
  return backendKind !== "tmux-pane" && backendKind !== "tmux-window";
}

/**
 * Push this window's terminal size to the backend. Only the desktop window
 * does this — it owns the PTY — and it tells the replicas what it settled on.
 */
function syncBackendTerminalSize(terminalId: string, cols: number, rows: number) {
  if (!isPrimaryClient()) {
    return;
  }
  resizeTerminal(terminalId, cols, rows).catch(() => {});
  mirrorTerminalSize(terminalId, cols, rows);
}

function markPastedTerminalActivity(terminalId: string, text: string) {
  if (text.includes("\n") || text.includes("\r")) {
    useTerminalStore.getState().updateCwd(terminalId, undefined);
  }
  useTerminalStore.getState().markTerminalActivity(terminalId);
  reflectImmediateTabActivity(terminalId);
}

function emitPasteProgressChange(terminalId: string) {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(
    new CustomEvent(TERMINAL_PASTE_PROGRESS_EVENT, {
      detail: { terminalId },
    })
  );
}

function setTerminalPasteProgress(
  terminalId: string,
  progress: Omit<TerminalPasteProgress, "terminalId" | "updatedAt"> | null
) {
  if (!progress) {
    if (pasteProgressByTerminal.delete(terminalId)) {
      emitPasteProgressChange(terminalId);
    }
    return;
  }

  pasteProgressByTerminal.set(terminalId, {
    terminalId,
    ...progress,
    updatedAt: Date.now(),
  });
  emitPasteProgressChange(terminalId);
}

export function getTerminalPasteProgress(terminalId: string): TerminalPasteProgress | null {
  return pasteProgressByTerminal.get(terminalId) ?? null;
}

export function subscribeTerminalPasteProgress(
  terminalId: string,
  listener: (progress: TerminalPasteProgress | null) => void
): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }

  const handleProgress = (event: Event) => {
    const detail = (event as CustomEvent<{ terminalId?: string }>).detail;
    if (detail?.terminalId !== terminalId) {
      return;
    }
    listener(getTerminalPasteProgress(terminalId));
  };
  window.addEventListener(TERMINAL_PASTE_PROGRESS_EVENT, handleProgress);
  return () => window.removeEventListener(TERMINAL_PASTE_PROGRESS_EVENT, handleProgress);
}

export function useTerminalPasteProgress(terminalId: string): TerminalPasteProgress | null {
  const [progress, setProgress] = useState<TerminalPasteProgress | null>(
    () => getTerminalPasteProgress(terminalId)
  );

  useEffect(() => {
    setProgress(getTerminalPasteProgress(terminalId));
    return subscribeTerminalPasteProgress(terminalId, setProgress);
  }, [terminalId]);

  return progress;
}

async function pasteTextIntoTerminal(terminalId: string, xterm: Terminal, text: string) {
  pushKeyDebug(`terminal.paste-data:${terminalId}`, describeTerminalData(text));
  xterm.focus();

  const backendKind = useTerminalStore.getState().sessions[terminalId]?.backendKind ?? "local";
  if (backendKind === "tmux-pane") {
    markPastedTerminalActivity(terminalId, text);
    xterm.scrollToBottom();
    const startedAt = Date.now();
    setTerminalPasteProgress(terminalId, {
      phase: "preparing",
      completedChunks: 0,
      totalChunks: null,
      totalBytes: text.length,
      startedAt,
    });
    try {
      await sendPasteToTmuxTerminal(terminalId, text, {
        onProgress: (progress) => {
          setTerminalPasteProgress(terminalId, {
            ...progress,
            startedAt,
          });
        },
      });
    } finally {
      setTerminalPasteProgress(terminalId, null);
    }
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

export function stripGeneratedTerminalResponseSequences(data: string): {
  data: string;
  strippedBytes: number;
  strippedCount: number;
} {
  let strippedBytes = 0;
  let strippedCount = 0;
  TERMINAL_RESPONSE_SEQUENCE_PATTERN.lastIndex = 0;
  const sanitized = data.replace(TERMINAL_RESPONSE_SEQUENCE_PATTERN, (match) => {
    strippedBytes += match.length;
    strippedCount += 1;
    return "";
  });
  TERMINAL_RESPONSE_SEQUENCE_PATTERN.lastIndex = 0;

  return {
    data: sanitized,
    strippedBytes,
    strippedCount,
  };
}

function clearBufferedWriteTimeout(terminalId: string) {
  const timeoutId = writeTimeouts.get(terminalId);
  if (timeoutId !== undefined) {
    clearTimeout(timeoutId);
    writeTimeouts.delete(terminalId);
  }
}

function scheduleHiddenWriteFallback(terminalId: string) {
  if (writeTimeouts.has(terminalId) || typeof document === "undefined") {
    return;
  }
  if (document.visibilityState === "visible") {
    return;
  }

  const timeoutId = setTimeout(() => {
    writeTimeouts.delete(terminalId);
    const rafId = writeRafs.get(terminalId);
    if (rafId !== undefined) {
      cancelAnimationFrame(rafId);
      writeRafs.delete(terminalId);
    }
    drainTerminalWriteBuffer(terminalId);
  }, HIDDEN_WRITE_FALLBACK_MS);
  writeTimeouts.set(terminalId, timeoutId);
}

function flushBufferedWrite(terminalId: string) {
  const rafId = writeRafs.get(terminalId);
  if (rafId !== undefined) {
    cancelAnimationFrame(rafId);
    writeRafs.delete(terminalId);
  }
  clearBufferedWriteTimeout(terminalId);

  drainTerminalWriteBuffer(terminalId);
}

function scheduleBufferedWrite(terminalId: string) {
  if (writeInFlight.has(terminalId)) {
    return;
  }

  if (writeRafs.has(terminalId)) {
    scheduleHiddenWriteFallback(terminalId);
    return;
  }

  const rafId = requestAnimationFrame(() => {
    writeRafs.delete(terminalId);
    clearBufferedWriteTimeout(terminalId);
    drainTerminalWriteBuffer(terminalId);
  });
  writeRafs.set(terminalId, rafId);
  scheduleHiddenWriteFallback(terminalId);
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

  const instance = instances.get(terminalId);
  const xterm = instance?.xterm;
  if (!xterm) {
    // No frontend yet — keep the data (and its batch flags) buffered so it
    // renders once the instance is created, instead of silently dropping it.
    writeStatusRecorded.delete(terminalId);
    return;
  }

  const chunkCount = buf.length;
  const combined = buf.join("");
  buf.length = 0;
  const allowParkedWrite = writeBufferAllowParked.delete(terminalId);
  const clearScrollbackBeforeWrite = writeBufferClearScrollback.delete(terminalId);
  const skippedTmuxWriteReason = allowParkedWrite
    ? null
    : getSkippedTmuxWriteReason(terminalId, instance);
  if (skippedTmuxWriteReason) {
    recordParkedTmuxWriteDrop(terminalId, combined, skippedTmuxWriteReason);
    writeStatusRecorded.delete(terminalId);
    return;
  }

  const drainStartedAt = performance.now();
  if (combined.length >= LARGE_WRITE_DRAIN_BYTES) {
    debugLog("terminal.output", "large buffered write drain", {
      terminalId,
      backendKind: getTerminalBackendKind(terminalId),
      chunks: chunkCount,
      bytes: combined.length,
      visibilityState: typeof document === "undefined" ? null : document.visibilityState,
    });
  }

  writeInFlight.add(terminalId);
  let viewportOffsetFromBottom: number | null = null;
  if (clearScrollbackBeforeWrite) {
    const activeBuffer = xterm.buffer.active;
    viewportOffsetFromBottom = Math.max(0, activeBuffer.baseY - activeBuffer.viewportY);

    // xterm.clear() resets ybase/ydisp but leaves its internal
    // isUserScrolling flag alone. If a pane was ever scrolled up, rebuilding
    // tmux history from that state keeps ydisp pinned at zero while the replay
    // grows below it, leaving the pane at the very top of scrollback. Moving to
    // the bottom first releases that scroll lock; restore the user's relative
    // viewport after the authoritative replay has finished parsing.
    xterm.scrollToBottom();
    xterm.clear();
  }
  xterm.write(combined, () => {
    if (viewportOffsetFromBottom !== null) {
      if (viewportOffsetFromBottom === 0) {
        xterm.scrollToBottom();
      } else {
        xterm.scrollToLine(Math.max(0, xterm.buffer.active.baseY - viewportOffsetFromBottom));
      }
    }
    const durationMs = performance.now() - drainStartedAt;
    writeInFlight.delete(terminalId);
    writeStatusRecorded.delete(terminalId);
    if (durationMs >= SLOW_WRITE_DRAIN_MS) {
      debugLog("terminal.output", "slow buffered write drain", {
        terminalId,
        backendKind: getTerminalBackendKind(terminalId),
        bytes: combined.length,
        durationMs,
        visibilityState: typeof document === "undefined" ? null : document.visibilityState,
      });
    }
    if ((writeBuffers.get(terminalId)?.length ?? 0) > 0) {
      scheduleBufferedWrite(terminalId);
    }
  });
}

function isRecordableTerminalOutput(data: string, options?: QueuedTerminalOutputOptions): boolean {
  return (
    options?.recordActivity !== false
    && data.length > 0
    && !isTransientFocusSequence(data)
    && hasTerminalActivityOutput(data)
  );
}

function recordTerminalOutputActivity(terminalId: string) {
  const terminalStore = useTerminalStore.getState();
  const resizeSuppression = getActiveStatusResizeSuppression([terminalId]);
  const session = terminalStore.sessions[terminalId];
  if (
    resizeSuppression
    && (session?.lastUserInputAt ?? 0) <= resizeSuppression.startedAt
  ) {
    debugLog("terminal.output", "suppress output activity during resize", {
      terminalId,
      reason: resizeSuppression.reason,
      suppressionTerminalId: resizeSuppression.terminalId,
      suppressionUntil: resizeSuppression.until,
    });
    return;
  }

  terminalStore.markTerminalOutput(terminalId);
  reflectImmediateTabOutput(terminalId);
}

function markTerminalStatusResizeSuppression(terminalId: string, reason: string) {
  const terminalStore = useTerminalStore.getState();
  const layouts = useLayoutStore.getState().layouts;
  const tabRootTerminalId = findLayoutKeyForTerminal(layouts, terminalId) ?? terminalId;
  const statusTerminalIds = getTabStatusTerminalIds(
    layouts,
    tabRootTerminalId,
    new Set(Object.keys(terminalStore.sessions))
  );

  markStatusResizeSuppression([terminalId, tabRootTerminalId, ...statusTerminalIds], reason);
}

function maybeRecordDroppedParkedTmuxActivity(
  terminalId: string,
  data: string,
  options?: QueuedTerminalOutputOptions
) {
  if (!isRecordableTerminalOutput(data, options)) {
    return;
  }

  const now = Date.now();
  const lastRecordedAt = parkedTmuxActivityLastRecordedAt.get(terminalId);
  if (
    lastRecordedAt !== undefined
    && now - lastRecordedAt < PARKED_TMUX_ACTIVITY_THROTTLE_MS
  ) {
    return;
  }

  parkedTmuxActivityLastRecordedAt.set(terminalId, now);
  recordTerminalOutputActivity(terminalId);
}

function recordParkedTmuxWriteDrop(
  terminalId: string,
  data: string,
  reason: SkippedTmuxWriteReason
) {
  const now = Date.now();
  let summary = parkedTmuxWriteDrops.get(terminalId);
  if (!summary) {
    summary = {
      chunks: 0,
      bytes: 0,
      lastLoggedAt: now,
      reason,
    };
    parkedTmuxWriteDrops.set(terminalId, summary);
    // Dropped output is one of the likeliest reasons a pane ends up drawing
    // something stale, so it goes in the recording rather than only the log.
    recordSessionEvent("pane-output-dropped", {
      terminalId,
      reason,
      bytes: data.length,
      backendKind: getTerminalBackendKind(terminalId),
    });
    debugLog("terminal.output", "dropping parked tmux output", {
      terminalId,
      backendKind: getTerminalBackendKind(terminalId),
      reason,
      visibilityState: typeof document === "undefined" ? null : document.visibilityState,
    });
  }

  summary.chunks += 1;
  summary.bytes += data.length;
  summary.reason = reason;

  if (now - summary.lastLoggedAt < PARKED_TMUX_DROP_SUMMARY_INTERVAL_MS) {
    return;
  }

  debugLog("terminal.output", "parked tmux output drop summary", {
    terminalId,
    backendKind: getTerminalBackendKind(terminalId),
    reason: summary.reason,
    chunks: summary.chunks,
    bytes: summary.bytes,
    intervalMs: now - summary.lastLoggedAt,
    visibilityState: typeof document === "undefined" ? null : document.visibilityState,
  });
  summary.chunks = 0;
  summary.bytes = 0;
  summary.lastLoggedAt = now;
}

function batchedWrite(
  terminalId: string,
  data: string,
  options?: QueuedTerminalOutputOptions
): boolean {
  if (!options?.allowParkedWrite) {
    const skippedTmuxWriteReason = getSkippedTmuxWriteReason(
      terminalId,
      instances.get(terminalId)
    );
    if (skippedTmuxWriteReason) {
      maybeRecordDroppedParkedTmuxActivity(terminalId, data, options);
      recordParkedTmuxWriteDrop(terminalId, data, skippedTmuxWriteReason);
      return false;
    }
  }

  // Every terminal's output converges here — local PTYs and tmux panes alike,
  // the latter already decoded out of the control protocol. Mirroring at this
  // point is what lets a replica render tmux exactly like the desktop does.
  mirrorTerminalOutput(terminalId, data);

  noteTerminalOutput(terminalId, data.length);

  // Record the decoded stream for tmux panes. A local shell's bytes are the
  // PTY's bytes, which the backend already captured at the transport.
  const recordedBackendKind = getTerminalBackendKind(terminalId);
  if (recordedBackendKind === "tmux-pane" || recordedBackendKind === "tmux-window") {
    recordPaneOutput(terminalId, data);
  }

  let buffer = writeBuffers.get(terminalId);
  if (!buffer) {
    buffer = [];
    writeBuffers.set(terminalId, buffer);
  } else if (options?.replaceBufferedOutput) {
    buffer.length = 0;
    writeBufferAllowParked.delete(terminalId);
    writeBufferClearScrollback.delete(terminalId);
  }
  buffer.push(data);

  // A terminal whose frontend is not draining (no instance yet, a stalled
  // renderer) must not accumulate without limit. Dropping the oldest output is
  // better than growing until the tab, and the backpressure behind it, seizes
  // up — that backpressure reaches all the way to a remote tmux client.
  let buffered = 0;
  for (const chunk of buffer) {
    buffered += chunk.length;
  }
  if (buffered > MAX_BUFFERED_WRITE_BYTES) {
    let dropped = 0;
    while (buffer.length > 1 && buffered > MAX_BUFFERED_WRITE_BYTES) {
      dropped += buffer[0].length;
      buffered -= buffer[0].length;
      buffer.shift();
    }
    debugLog("terminal.output", "dropped buffered output over the cap", {
      terminalId,
      dropped,
      remaining: buffered,
      cap: MAX_BUFFERED_WRITE_BYTES,
    });
    recordSessionEvent("output-buffer-overflow", { terminalId, dropped, remaining: buffered });
  }

  if (options?.allowParkedWrite) {
    writeBufferAllowParked.add(terminalId);
  }
  if (options?.clearScrollbackBeforeWrite) {
    writeBufferClearScrollback.add(terminalId);
  }

  // Activity timestamps drive the status dots and live in the workspace
  // document. The desktop window is the one that observes real terminal output,
  // so a replica leaves them alone and takes the dots from shared state.
  const shouldRecordOutput =
    isPrimaryClient()
    && isRecordableTerminalOutput(data, options)
    && !writeStatusRecorded.has(terminalId);
  if (shouldRecordOutput) {
    writeStatusRecorded.add(terminalId);
    recordTerminalOutputActivity(terminalId);
  }

  // Flush immediately when the guest queries the terminal (DSR/DA/OSC color
  // queries) so xterm can answer without a frame of latency. Scan only the
  // new chunk plus a short tail of the previous one so a query split across
  // IPC chunks is still caught without re-joining the whole buffer (which is
  // quadratic during large output bursts).
  if (data.includes("\u001b") || buffer.length > 1) {
    const previousTail = buffer.length > 1
      ? buffer[buffer.length - 2].slice(-RESPONSE_QUERY_BOUNDARY_TAIL_CHARS)
      : "";
    if (containsTerminalResponseQuery(previousTail + data)) {
      flushBufferedWrite(terminalId);
      return true;
    }
  }

  scheduleBufferedWrite(terminalId);
  return true;
}

export function queueTerminalOutput(
  terminalId: string,
  data: string,
  options?: QueuedTerminalOutputOptions
): boolean {
  return batchedWrite(terminalId, data, options);
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
  clearBufferedWriteTimeout(terminalId);
  writeBuffers.delete(terminalId);
  writeBufferAllowParked.delete(terminalId);
  writeBufferClearScrollback.delete(terminalId);
  writeInFlight.delete(terminalId);
  writeStatusRecorded.delete(terminalId);
  parkedTmuxWriteDrops.delete(terminalId);
  parkedTmuxActivityLastRecordedAt.delete(terminalId);
}

function isParkedTerminalInstance(instance: TerminalInstance): boolean {
  return instance.element.parentElement?.id === PARKING_ROOT_ID;
}

function getTerminalBackendKind(terminalId: string): TerminalBackendKind | undefined {
  return useTerminalStore.getState().sessions[terminalId]?.backendKind;
}

function getSkippedTmuxWriteReason(
  terminalId: string,
  instance: TerminalInstance | undefined
): SkippedTmuxWriteReason | null {
  const backendKind = getTerminalBackendKind(terminalId);
  if (backendKind !== "tmux-pane" && backendKind !== "tmux-window") {
    return null;
  }

  if (!instance) {
    return "missing-frontend";
  }

  return isParkedTerminalInstance(instance) ? "parked" : null;
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

/** Per-terminal dictation revision tracking; see `resolveDictationInput`. */
const dictationStates = new Map<string, DictationState>();

export function handleTerminalInputData(terminalId: string, inputFromKeyboard: string) {
  let data = inputFromKeyboard;

  // A soft keyboard has no Ctrl key. When the on-screen key bar has armed it,
  // fold the modifier into this keystroke and disarm.
  if (useUiStore.getState().isCtrlArmed) {
    useUiStore.getState().setCtrlArmed(false);
    const chord = toControlCharacter(data);
    if (chord) {
      data = chord;
    }
  }

  // iOS dictation re-sends the whole phrase on every revision, expecting the
  // target to replace its value. A terminal has no value to replace, so the
  // revisions would concatenate; send only what is new.
  const dictation = resolveDictationInput({
    data,
    previous: dictationStates.get(terminalId) ?? null,
    now: Date.now(),
  });
  if (dictation.next === null) {
    dictationStates.delete(terminalId);
  } else {
    dictationStates.set(terminalId, dictation.next);
  }
  data = dictation.emit;
  if (data.length === 0) {
    return;
  }

  pushKeyDebug(`xterm.onData:${terminalId}`, describeTerminalData(data));

  // A replica does not hold the PTY or the tmux transport, so typing there is
  // sent to the desktop window and the desktop does the writing. The echo comes
  // back through the mirror like any other output.
  if (isReplicaClient()) {
    performAction("terminalInput", terminalId, data);
    return;
  }

  noteTerminalInput(terminalId, data);

  const backendKind = useTerminalStore.getState().sessions[terminalId]?.backendKind ?? "local";
  let inputData = data;
  if (backendKind === "tmux-pane") {
    const sanitized = stripGeneratedTerminalResponseSequences(inputData);
    if (sanitized.strippedCount > 0) {
      debugLog("terminal.input", "suppress generated terminal response for tmux pane", {
        terminalId,
        strippedBytes: sanitized.strippedBytes,
        strippedCount: sanitized.strippedCount,
        forwardedBytes: sanitized.data.length,
        rawPreview: describeTerminalData(data),
        forwardedPreview: sanitized.data.length > 0 ? describeTerminalData(sanitized.data) : "",
      });
      pushKeyDebug(
        `xterm.terminal-response-suppressed:${terminalId}`,
        describeTerminalData(data)
      );
      inputData = sanitized.data;
      if (inputData.length === 0) {
        return;
      }
      pushKeyDebug(`xterm.onData-sanitized:${terminalId}`, describeTerminalData(inputData));
    }
  }
  if (shouldSuppressSyntheticEcho(terminalId, inputData)) {
    pushKeyDebug(`xterm.synthetic-echo-suppressed:${terminalId}`, describeTerminalData(inputData));
    return;
  }
  if (shouldSuppressTransientFocusSequence(terminalId, inputData)) {
    pushKeyDebug(`xterm.focus-sequence-suppressed:${terminalId}`, describeTerminalData(inputData));
    return;
  }
  // Any submitted command may change cwd; force a fresh lookup on next spawn.
  if (inputData.includes("\r")) {
    useTerminalStore.getState().updateCwd(terminalId, undefined);
  }
  if (!isTransientFocusSequence(inputData)) {
    useTerminalStore.getState().markTerminalActivity(terminalId);
    reflectImmediateTabActivity(terminalId);
  }
  pushKeyDebug(`pty.write-request:${terminalId}`, describeTerminalData(inputData));
  if (backendKind === "tmux-pane") {
    sendInputToTmuxTerminal(terminalId, inputData).catch(() => {});
  } else {
    writeTerminal(terminalId, inputData).catch(() => {});
  }
}

/** Re-fit every terminal; the compact policy or the viewport just changed. */
export function refitAllTerminalsToViewport() {
  for (const terminalId of instances.keys()) {
    fitTerminalFontToViewport(terminalId);
  }
}

// A narrow-screen fit depends on the chosen policy and the viewport, neither of
// which the per-terminal effects watch.
useUiStore.subscribe((state, previous) => {
  if (state.compactTerminalFit !== previous.compactTerminalFit) {
    refitAllTerminalsToViewport();
  }
  // Switching what a swipe does moves which box holds the scroll offset, so
  // whichever one is now live has to be put back at the newest output — or the
  // toggle lands the reader somewhere in the middle of the grid.
  if (state.compactTouchGesture !== previous.compactTouchGesture) {
    for (const terminalId of instances.keys()) {
      syncHistoryScrollProxy(terminalId, { follow: true });
      scrollTerminalToBottom(terminalId);
    }
  }
});

if (typeof window !== "undefined") {
  window.addEventListener("resize", () => refitAllTerminalsToViewport());
  window.addEventListener("orientationchange", () => refitAllTerminalsToViewport());
}

globalThis.__dispatcherTerminalInputRouter = handleTerminalInputData;

// Terminal grids live in the xterm instances here, so replication asks this
// module rather than the other way round.
setTerminalGridProvider((terminalId) => {
  const xterm = instances.get(terminalId)?.xterm;
  if (!xterm || xterm.cols <= 0 || xterm.rows <= 0) {
    return null;
  }
  return { cols: xterm.cols, rows: xterm.rows };
});

// Typing in a browser replica arrives here, on the desktop window, and is
// written to the real PTY or tmux pane exactly as if it had been typed locally.
registerActionHandler("terminalInput", (terminalId, data) => {
  handleTerminalInputData(terminalId, data);
});

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
// - default off (opt-in only via the environment-scoped WebGL localStorage key)
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
        if (!shouldOpenLink(event)) {
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

  xterm.registerLinkProvider({
    provideLinks: (bufferLineNumber, callback) => {
      const links = findTerminalWebLinkMatches(xterm, bufferLineNumber).map(({ text, range }) => ({
        text,
        range,
        activate: (event: MouseEvent) => {
          const modifierPressed = isLinkOpenModifierPressed(event);
          const backendKind = useTerminalStore.getState().sessions[terminalId]?.backendKind ?? "local";

          debugLog("terminal.link", "activate", {
            terminalId,
            backendKind,
            uri: text,
            range,
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
          void open(text).catch(() => {});
        },
        hover: (event: MouseEvent) => {
          const target = event.target as HTMLElement | null;
          if (!target) {
            return;
          }

          const isMac = navigator.platform.startsWith("Mac");
          target.title = isMac ? `Cmd-click to open ${text}` : `Ctrl-click to open ${text}`;
        },
        leave: (event: MouseEvent) => {
          const target = event.target as HTMLElement | null;
          if (target) {
            target.removeAttribute("title");
          }
        },
      }));
      callback(links);
    },
  });

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
      void clearTmuxTerminal(terminalId).catch((error) => {
        debugLog("terminal.shortcut", "tmux clear failed", {
          terminalId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return false;
    }

    if (e.metaKey && ["t", "n", "d", "w", "f", "u", "r", "l", "b", "=", "-", "0"].includes(e.key.toLowerCase())) {
      return false;
    }
    if (e.metaKey && (e.code === "BracketLeft" || e.code === "BracketRight")) {
      return false;
    }

    return true;
  });

  attachTouchSelection(terminalId, instance);
  attachTouchScrollback(terminalId, instance);
  instances.set(terminalId, instance);
  // Output that arrived before the frontend existed is still buffered;
  // schedule a drain now that there is an xterm to render it into.
  if ((writeBuffers.get(terminalId)?.length ?? 0) > 0) {
    scheduleBufferedWrite(terminalId);
  }
  return instance;
}

/** Marks the scrolling box while a selection is being dragged. */
const TOUCH_SELECTING_CLASS = "terminal-touch-selecting";

/** Movement before a swipe is committed to one axis. */
const TOUCH_AXIS_LOCK_SLOP_PX = 8;

/**
 * Where a scroll position lands in the buffer, and how far the grid has to
 * shift to show it.
 *
 * The document being scrolled is every line the buffer holds — scrollback and
 * the current screen as one surface. xterm can only draw `rows` of them at a
 * time, positioned at `baseY` at the furthest, so past that point the grid
 * stops moving and the element itself is shifted instead. On a phone the grid
 * is routinely taller than the screen (67 rows in a 24-row viewport here), so
 * both parts are needed: scrolling through history *and* over the rows of the
 * current screen that do not fit.
 */
export function resolveProxyScrollPosition(args: {
  scrollTopPx: number;
  cellHeightPx: number;
  bufferLines: number;
  rows: number;
  baseY: number;
}): { line: number; offsetPx: number } {
  if (!(args.cellHeightPx > 0)) {
    return { line: 0, offsetPx: 0 };
  }

  const maxDocumentLine = Math.max(0, args.bufferLines - 1);
  const documentLine = Math.min(
    maxDocumentLine,
    Math.max(0, Math.round(args.scrollTopPx / args.cellHeightPx))
  );
  const line = Math.min(documentLine, Math.max(0, args.baseY));
  return {
    line,
    offsetPx: Math.max(0, documentLine - line) * args.cellHeightPx,
  };
}

/**
 * How tall the scrollable surface is beyond the grid element itself.
 *
 * The grid occupies `rows` of the document in normal flow, so the spacer only
 * has to account for the lines above it.
 */
export function resolveProxySpacerHeight(
  bufferLines: number,
  rows: number,
  cellHeightPx: number
): number {
  if (!(cellHeightPx > 0)) {
    return 0;
  }
  return Math.max(0, (bufferLines - rows) * cellHeightPx);
}

/**
 * Turn a finger's travel into whole lines of scrollback.
 *
 * The remainder is carried between moves: a finger produces many small deltas,
 * and rounding each one on its own throws most of them away, so a slow drag
 * would move nothing at all.
 */
export function consumeTouchScrollLines(
  carryLines: number,
  deltaPx: number,
  cellHeightPx: number
): { lines: number; carryLines: number } {
  if (!Number.isFinite(deltaPx) || !(cellHeightPx > 0)) {
    return { lines: 0, carryLines };
  }

  const total = carryLines + deltaPx / cellHeightPx;
  const lines = Math.trunc(total);
  return { lines, carryLines: total - lines };
}

/**
 * Scroll the buffer with a finger.
 *
 * xterm has no scrollable element to hand the gesture to — `.xterm-viewport`
 * is `overflow-y: scroll` but nothing inside it is ever taller, so scrollback
 * moves only through `scrollLines()`, which the wheel drives. A phone produces
 * no wheel events, so the history was unreachable by touch no matter which box
 * the browser gave the swipe to.
 *
 * Only the vertical axis is taken, and only once the swipe has committed to it,
 * so panning sideways across a wide grid still belongs to the box that scrolls.
 */
interface HistoryScrollProxy {
  container: HTMLElement;
  spacer: HTMLElement;
  /** Set while we move the box ourselves, so the sync does not chase itself. */
  applying: boolean;
}

const historyScrollProxies = new Map<string, HistoryScrollProxy>();

/** Whether the browser should own the vertical gesture for this terminal. */
export function isHistoryScrollProxyActive(): boolean {
  return isCompactViewport() && useUiStore.getState().compactTouchGesture === "history";
}

/**
 * Let the browser scroll the buffer natively.
 *
 * xterm's own scroller is synthetic — nothing inside it is ever taller than it
 * is — so a phone has nothing to scroll and the history stays out of reach. A
 * spacer next to the grid gives the box real height, the grid is pinned in
 * place with `sticky`, and the buffer is moved to follow the box. Scrolling is
 * then the browser's, so the momentum and rubber-banding come for free rather
 * than being reimplemented.
 */
/** Move the buffer and the grid to wherever the box is now scrolled. */
function applyHistoryScrollPosition(
  terminalId: string,
  proxy: HistoryScrollProxy,
  instance: TerminalInstance
) {
  const cell = getTerminalCellSize(terminalId);
  if (!cell) {
    return;
  }

  const buffer = instance.xterm.buffer.active;
  const position = resolveProxyScrollPosition({
    scrollTopPx: proxy.container.scrollTop,
    cellHeightPx: cell.height,
    bufferLines: buffer.length,
    rows: instance.xterm.rows,
    baseY: buffer.baseY,
  });
  instance.xterm.scrollToLine(position.line);
  instance.element.style.transform = position.offsetPx > 0
    ? `translateY(${-position.offsetPx}px)`
    : "";
}

function isHistoryScrollProxyAtBottom(proxy: HistoryScrollProxy): boolean {
  return isScrolledToBottom(
    proxy.container.scrollTop,
    proxy.container.scrollHeight,
    proxy.container.clientHeight
  );
}

function syncHistoryScrollProxy(terminalId: string, options?: { follow?: boolean }) {
  const proxy = historyScrollProxies.get(terminalId);
  const instance = instances.get(terminalId);
  if (!proxy || !instance) {
    return;
  }

  if (!isHistoryScrollProxyActive()) {
    proxy.spacer.style.height = "0px";
    instance.element.style.transform = "";
    return;
  }

  const cell = getTerminalCellSize(terminalId);
  if (!cell) {
    return;
  }

  const buffer = instance.xterm.buffer.active;
  proxy.spacer.style.height =
    `${resolveProxySpacerHeight(buffer.length, instance.xterm.rows, cell.height)}px`;

  if (options?.follow) {
    proxy.applying = true;
    proxy.container.scrollTop = proxy.container.scrollHeight;
    // The bottom of the document is past the last line the grid can move to,
    // so the newest rows are only reachable through the element offset —
    // clearing it here would jump back to the top of the grid.
    applyHistoryScrollPosition(terminalId, proxy, instance);
    // Released next frame: the scroll event this just caused has to see the
    // flag, or it maps a position we set ourselves back onto the buffer.
    requestAnimationFrame(() => {
      proxy.applying = false;
    });
  }
}

function attachHistoryScrollProxy(
  terminalId: string,
  instance: TerminalInstance,
  container: HTMLElement
) {
  const existing = historyScrollProxies.get(terminalId);
  if (existing?.container === container) {
    return;
  }
  existing?.spacer.remove();

  const spacer = document.createElement("div");
  spacer.className = "terminal-history-spacer";
  spacer.setAttribute("aria-hidden", "true");
  container.appendChild(spacer);

  const proxy: HistoryScrollProxy = { container, spacer, applying: false };
  historyScrollProxies.set(terminalId, proxy);

  container.addEventListener("scroll", () => {
    if (proxy.applying || !isHistoryScrollProxyActive()) {
      return;
    }
    applyHistoryScrollPosition(terminalId, proxy, instance);
  }, { passive: true });

  // Output grows the document, so the surface has to grow with it — and keep
  // the reader pinned to the newest line only if that is where they already
  // were. Anywhere else is a deliberate position and must be left alone.
  instance.xterm.onRender(() => {
    if (!isHistoryScrollProxyActive() || proxy.applying) {
      return;
    }
    syncHistoryScrollProxy(terminalId, { follow: isHistoryScrollProxyAtBottom(proxy) });
  });

  syncHistoryScrollProxy(terminalId, { follow: true });
}

function attachTouchScrollback(terminalId: string, instance: TerminalInstance) {
  if (!isTouchPointer()) {
    return;
  }

  const element = instance.element;
  let tracking = false;
  let startX = 0;
  let startY = 0;
  let lastY = 0;
  let axis: "undecided" | "vertical" | "horizontal" = "undecided";
  let carryLines = 0;

  element.addEventListener("touchstart", (event) => {
    tracking = event.touches.length === 1;
    if (!tracking) {
      return;
    }
    const touch = event.touches[0];
    startX = touch.clientX;
    startY = touch.clientY;
    lastY = touch.clientY;
    axis = "undecided";
    carryLines = 0;
  }, { passive: true });

  element.addEventListener("touchmove", (event) => {
    if (!tracking || event.touches.length !== 1) {
      return;
    }
    // A long press already claimed this drag to extend a selection.
    if (element.classList.contains(TOUCH_SELECTING_CLASS)) {
      return;
    }
    if (!isCompactViewport() || useUiStore.getState().compactTouchGesture !== "history") {
      return;
    }
    // The native proxy owns the gesture whenever it actually has height to
    // scroll. This stays as the fallback for when it does not, so a phone is
    // never left with no way to reach the history at all.
    const proxy = historyScrollProxies.get(terminalId);
    if (proxy && proxy.container.scrollHeight > proxy.container.clientHeight) {
      return;
    }

    const touch = event.touches[0];
    if (axis === "undecided") {
      const dx = Math.abs(touch.clientX - startX);
      const dy = Math.abs(touch.clientY - startY);
      if (dx + dy < TOUCH_AXIS_LOCK_SLOP_PX) {
        return;
      }
      axis = dy > dx ? "vertical" : "horizontal";
    }
    if (axis !== "vertical") {
      return;
    }

    const cell = getTerminalCellSize(terminalId);
    if (!cell) {
      return;
    }

    // Dragging the finger up walks towards newer output, matching the way the
    // content follows the finger everywhere else on a touch screen.
    const consumed = consumeTouchScrollLines(carryLines, lastY - touch.clientY, cell.height);
    lastY = touch.clientY;
    carryLines = consumed.carryLines;
    if (consumed.lines !== 0) {
      instance.xterm.scrollLines(consumed.lines);
    }
    if (event.cancelable) {
      event.preventDefault();
    }
  }, { passive: false });

  const stop = () => {
    tracking = false;
  };
  element.addEventListener("touchend", stop, { passive: true });
  element.addEventListener("touchcancel", stop, { passive: true });
}

/**
 * Long-press to start selecting, then drag to move the far end of the range.
 *
 * A long press is the one gesture scrolling does not already use, so it can
 * take over without stealing the pan. While selecting, the scrolling ancestor
 * has its touch handling disabled, or the drag would scroll instead of extend.
 */
function attachTouchSelection(terminalId: string, instance: TerminalInstance) {
  if (!isTouchPointer()) {
    return;
  }

  const element = instance.element;
  let anchor: TerminalCell | null = null;
  let pressAt: { x: number; y: number } | null = null;
  let pressTimer: number | null = null;

  const cancelPendingPress = () => {
    if (pressTimer !== null) {
      window.clearTimeout(pressTimer);
      pressTimer = null;
    }
    pressAt = null;
  };

  const scroller = () => findScrollContainer(element);

  const endSelection = () => {
    anchor = null;
    scroller()?.classList.remove(TOUCH_SELECTING_CLASS);
    element.classList.remove(TOUCH_SELECTING_CLASS);
  };

  const cellAt = (touch: { clientX: number; clientY: number }): TerminalCell | null => {
    const size = getTerminalCellSize(terminalId);
    if (!size) {
      return null;
    }
    const rect = element.getBoundingClientRect();
    return cellFromPoint({
      x: touch.clientX,
      y: touch.clientY,
      rect: { left: rect.left, top: rect.top },
      cellWidth: size.width,
      cellHeight: size.height,
      cols: instance.xterm.cols,
      rows: instance.xterm.rows,
      viewportY: instance.xterm.buffer.active.viewportY,
    });
  };

  element.addEventListener("touchstart", (event) => {
    // A fresh touch while a selection is up dismisses it, the way tapping
    // away from selected text does everywhere else.
    if (anchor !== null) {
      instance.xterm.clearSelection();
      endSelection();
      return;
    }
    if (event.touches.length !== 1) {
      return;
    }
    const touch = event.touches[0];
    pressAt = { x: touch.clientX, y: touch.clientY };
    pressTimer = window.setTimeout(() => {
      pressTimer = null;
      const cell = cellAt(touch);
      if (!cell) {
        return;
      }
      anchor = cell;
      scroller()?.classList.add(TOUCH_SELECTING_CLASS);
      element.classList.add(TOUCH_SELECTING_CLASS);

      // Start on the word under the finger rather than a single cell, which
      // is almost always what was meant and is hard to hit deliberately.
      const line = instance.xterm.buffer.active.getLine(cell.row)?.translateToString(true) ?? "";
      const word = wordRangeAt(line, cell.col);
      anchor = { col: word.start, row: cell.row };
      const range = selectionFromCells(anchor, { col: word.end, row: cell.row }, instance.xterm.cols);
      instance.xterm.select(range.column, range.row, range.length);
    }, LONG_PRESS_MS);
  }, { passive: true });

  element.addEventListener("touchmove", (event) => {
    if (anchor === null) {
      // Still deciding: a finger that travels was panning, not pressing.
      if (pressAt && event.touches.length === 1) {
        const touch = event.touches[0];
        if (movedTooFarForLongPress(pressAt, { x: touch.clientX, y: touch.clientY })) {
          cancelPendingPress();
        }
      }
      return;
    }

    const touch = event.touches[0];
    const focus = touch ? cellAt(touch) : null;
    if (!focus) {
      return;
    }
    // The scroller is inert now, so this drag is ours; stop the browser
    // treating it as a pan.
    event.preventDefault();
    const range = selectionFromCells(anchor, focus, instance.xterm.cols);
    instance.xterm.select(range.column, range.row, range.length);
  }, { passive: false });

  const finish = () => {
    cancelPendingPress();
    // The selection stays put so it can be copied; only the drag is over.
    scroller()?.classList.remove(TOUCH_SELECTING_CLASS);
  };
  element.addEventListener("touchend", finish, { passive: true });
  element.addEventListener("touchcancel", () => {
    cancelPendingPress();
    endSelection();
  }, { passive: true });
}

export function ensureTerminalFrontend(terminalId: string) {
  createTerminalInstance(terminalId);
}

/**
 * Attach the backend output channel for a terminal whose PTY is already
 * running, without waiting for its tab to be mounted.
 *
 * A tmux transport tab is normally never mounted — once tmux windows become
 * the visible tabs, nothing renders the transport itself. Mounting is what
 * usually creates the channel, so after a reload the backend would keep
 * reading that PTY into its replay ring while the control stream never
 * reached the router: input still works (it writes straight to the PTY) but
 * no output is ever parsed, leaving panes blank and commands queued forever.
 */
export function ensureTerminalOutputChannel(terminalId: string) {
  ensureTerminalBackend(terminalId);
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

  // A replica has no backend of its own. The desktop window owns every PTY and
  // the tmux control stream; the replica just renders the output it mirrors.
  if (isReplicaClient()) {
    return instance;
  }

  if (!createdPtys.has(terminalId)) {
    createdPtys.add(terminalId);

    const channel = new Channel<TerminalOutputPayload>();
    channel.onmessage = (msg) => {
      // Tauri channels live for the lifetime of the PTY. In dev, Vite can hot
      // swap tmuxControl.ts without recreating this callback, so resolve the
      // current router lazily instead of capturing a stale module function.
      const nextData = getCurrentTmuxTransportOutputRouter()(msg.terminal_id, msg.data);
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
  const fontFamily = typeof xterm.options.fontFamily === "string" ? xterm.options.fontFamily : "Menlo, monospace";

  context.fillStyle = background;
  context.fillRect(0, 0, width, height);

  const cellHeight = height / Math.max(xterm.rows, 1);
  // cellHeight already reflects the configured line height; multiplying the
  // baseline by lineHeight again pushed text out of its row for lineHeight>1.
  const baselineOffset = Math.min(cellHeight - 2, Math.max(fontSize, cellHeight * 0.8));

  context.font = `${fontSize}px ${fontFamily}`;
  context.textBaseline = "alphabetic";
  context.fillStyle = foreground;

  for (let row = 0; row < xterm.rows; row++) {
    const line = buffer.getLine(buffer.viewportY + row);
    const text = line?.translateToString(false) ?? "";
    context.fillText(text, 0, row * cellHeight + baselineOffset);
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

  // Read the live tail of the buffer (baseY), not the scrolled viewport.
  // Status hashing must track where new output lands: with viewportY, a
  // user scrolling back registers as a content change (false activity) and
  // real output below the scrolled view goes unseen (missed activity).
  for (let row = 0; row < xterm.rows; row += 1) {
    const line = buffer.getLine(buffer.baseY + row);
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
/**
 * The text a phone cannot select by hand.
 *
 * With the WebGL renderer the screen is pixels on a canvas, so there is no DOM
 * text for the browser to select, and xterm's own selection is driven by mouse
 * drags a touchscreen never produces. Returning the visible screen gives the
 * one thing that was actually wanted: getting the text out.
 */
export function readTerminalVisibleText(terminalId: string): string {
  const xterm = instances.get(terminalId)?.xterm;
  if (!xterm) {
    return "";
  }

  const selection = xterm.getSelection();
  if (selection) {
    return selection;
  }

  const buffer = xterm.buffer.active;
  const lines: string[] = [];
  for (let row = 0; row < xterm.rows; row += 1) {
    lines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "");
  }
  // Trailing blank rows are padding, not content.
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }
  return lines.join("\n");
}

export function focusTerminalInstance(terminalId: string) {
  instances.get(terminalId)?.xterm.focus();
  // Focusing on a phone is what raises the keyboard, which shrinks the box the
  // terminal lives in. Pin here as well as on the viewport change, so the
  // prompt is already in view rather than needing a scroll afterwards.
  scrollTerminalToBottom(terminalId, { afterKeyboard: true });
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
      // A parked terminal has no visible canvas. Repainting every parked xterm
      // on focus caused a large synchronous burst for restored workspaces; the
      // attach path already refreshes a terminal before it becomes visible.
      continue;
    }

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

/**
 * The desktop window decides how big a terminal is; a replica renders at that
 * size rather than fitting to its own window, so the two show identical
 * wrapping. Applied from mirrored `size` frames.
 */
export function applyMirroredTerminalSize(terminalId: string, cols: number, rows: number) {
  ensureTerminalFrontend(terminalId);
  syncTerminalFrontendSize(terminalId, cols, rows);
  fitTerminalFontToViewport(terminalId);
}

/** Write mirrored output into the replica's copy of a terminal. */
export function applyMirroredTerminalOutput(terminalId: string, data: string) {
  ensureTerminalFrontend(terminalId);
  // Follow the tail unless the reader has deliberately scrolled up. A replica
  // is handed a screenful of replay the moment it connects, and landing
  // halfway up it is useless — the prompt is what you came for.
  const wasAtBottom = isTerminalScrolledToBottom(terminalId);
  batchedWrite(terminalId, data, { allowParkedWrite: true });
  if (wasAtBottom) {
    scrollTerminalToBottom(terminalId);
  }
}

/** True when the viewport is showing the newest line. */
export function isTerminalScrolledToBottom(terminalId: string): boolean {
  const instance = instances.get(terminalId);
  if (!instance) {
    return true;
  }

  const buffer = instance.xterm.buffer.active;
  if (buffer.viewportY < buffer.baseY) {
    return false;
  }

  // On a narrow screen the grid is larger than the screen, so the box that
  // scrolls is `.terminal-container` rather than xterm's own scrollback.
  // Asking only xterm meant that while the reader had scrolled up there, every
  // chunk of output still counted as "at the bottom" and yanked them back.
  const scroller = findScrollContainer(instance.element);
  if (!scroller) {
    return true;
  }
  return isScrolledToBottom(scroller.scrollTop, scroller.scrollHeight, scroller.clientHeight);
}

/**
 * Whether a scrolling box is close enough to the bottom to keep following.
 *
 * A tolerance matters because fractional layout leaves a pixel or two of slack
 * at the true bottom; without it a terminal that is visually pinned would
 * decide the reader had scrolled away and stop following.
 */
export const FOLLOW_BOTTOM_TOLERANCE_PX = 8;

export function isScrolledToBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number
): boolean {
  return scrollHeight - clientHeight - scrollTop <= FOLLOW_BOTTOM_TOLERANCE_PX;
}

/**
 * Show the newest output.
 *
 * Two different boxes can be scrolled away from the bottom and both have to be
 * dealt with. xterm has its own scrollback, and on a narrow screen the grid is
 * wider and taller than the screen, so `.terminal-container` scrolls the
 * element itself — that second one is what leaves the prompt off screen when a
 * soft keyboard opens.
 *
 * Repeated on the next frame and again after the keyboard animation, because a
 * write queued through `batchedWrite` has not reached xterm yet, and because
 * iOS keeps resizing and scrolling for a few hundred milliseconds after the
 * keyboard starts moving.
 */
/**
 * Re-fit a terminal that has just become visible, and put it at the prompt.
 *
 * A tab that was parked keeps whatever font it had when it was last on screen.
 * Coming back to it on a phone — a much narrower viewport than the desktop it
 * was sized for — it renders enormous until something happens to re-fit it,
 * which is why switching tabs looked zoomed in. The horizontal scroll is reset
 * too, or a tab left scrolled sideways comes back showing the middle of its
 * lines.
 */
/**
 * Report which box actually scrolls, and whether the other one can be reached.
 *
 * There are two vertical scrollers in play and only one holds the scrollback.
 * xterm's `.xterm-viewport` is a *descendant* of the terminal element, while
 * the box `findScrollContainer` finds is an *ancestor* — so when the ancestor
 * scrolls, a gesture chains outward and can never fall through to the
 * scrollback underneath it.
 */
function logTerminalScrollGeometry(
  terminalId: string,
  instance: TerminalInstance,
  scroller: HTMLElement | null
) {
  const viewport = instance.element.querySelector<HTMLElement>(".xterm-viewport");
  debugLog("terminal.frontend", "scroll geometry", {
    terminalId,
    compact: isCompactViewport(),
    outerScroller: scroller?.className ?? null,
    outerScrollHeight: scroller?.scrollHeight ?? null,
    outerClientHeight: scroller?.clientHeight ?? null,
    outerScrollsVertically: scroller
      ? scroller.scrollHeight > scroller.clientHeight
      : false,
    viewportScrollHeight: viewport?.scrollHeight ?? null,
    viewportClientHeight: viewport?.clientHeight ?? null,
    scrollbackReachable: viewport
      ? viewport.scrollHeight > viewport.clientHeight
      : null,
  });
}

export function presentTerminalForViewport(terminalId: string) {
  const apply = () => {
    const instance = instances.get(terminalId);
    if (!instance) {
      return;
    }
    fitTerminalFontToViewport(terminalId);
    const scroller = findScrollContainer(instance.element);
    if (scroller) {
      scroller.scrollLeft = 0;
    }
    logTerminalScrollGeometry(terminalId, instance, scroller);
    scrollTerminalToBottom(terminalId, { afterKeyboard: true });
  };

  apply();
  if (typeof requestAnimationFrame === "function") {
    // Again once laid out: a tab that just appeared measures as nothing.
    requestAnimationFrame(apply);
  }
}

export function scrollTerminalToBottom(
  terminalId: string,
  options?: { afterKeyboard?: boolean }
) {
  const scroll = () => {
    const instance = instances.get(terminalId);
    if (!instance) {
      return;
    }
    instance.xterm.scrollToBottom();
    const scroller = findScrollContainer(instance.element);
    if (scroller) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  };

  scroll();
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(scroll);
  }
  // Only the keyboard needs the late pass. Scheduling one for every chunk of
  // output would leave a timer in flight that yanks the reader back a moment
  // after they scroll away.
  if (options?.afterKeyboard && typeof window !== "undefined") {
    window.setTimeout(scroll, KEYBOARD_SETTLE_MS);
  }
}

/** How long iOS keeps moving things after the keyboard begins to open. */
const KEYBOARD_SETTLE_MS = 300;

/** The nearest ancestor that actually scrolls, if any. */
export function findScrollContainer(element: HTMLElement | null): HTMLElement | null {
  let current: HTMLElement | null = element;
  while (current) {
    const style = typeof getComputedStyle === "function" ? getComputedStyle(current) : null;
    const overflowY = style?.overflowY ?? "";
    if (
      (overflowY === "auto" || overflowY === "scroll")
      && current.scrollHeight > current.clientHeight
    ) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

/** Clear a replica's terminal before the desktop replays its current screen. */
export function resetMirroredTerminal(terminalId: string) {
  const instance = instances.get(terminalId);
  if (instance) {
    instance.xterm.reset();
  }
}

/**
 * Smallest grid worth believing. Below this the element has not been laid out
 * yet; propagating it would resize the tmux pane to nonsense.
 */
const MIN_SYNCABLE_COLS = 10;
const MIN_SYNCABLE_ROWS = 2;

export function syncTerminalFrontendSize(terminalId: string, cols: number, rows: number) {
  const instance = instances.get(terminalId);
  if (!instance) {
    return;
  }

  const nextCols = Math.floor(cols);
  const nextRows = Math.floor(rows);

  // An element that is mid-mount or hidden measures as nothing, and clamping
  // that to a floor used to produce a plausible-looking 2x1 grid which was
  // then pushed to tmux as `refresh-client -C 2x1`. tmux reflows the pane and
  // its whole scrollback to two columns, and growing back does not undo it —
  // the pane is left full of mid-word wraps and duplicated fragments. No real
  // layout is this small, so treat it as "not measurable yet" and wait.
  if (
    !Number.isFinite(nextCols)
    || !Number.isFinite(nextRows)
    || nextCols < MIN_SYNCABLE_COLS
    || nextRows < MIN_SYNCABLE_ROWS
  ) {
    debugLog("terminal.frontend", "ignoring degenerate resize", {
      terminalId,
      cols,
      rows,
      currentCols: instance.xterm.cols,
      currentRows: instance.xterm.rows,
    });
    return;
  }

  // tmux panes are sized by tmux rather than by the viewport, so this is the
  // only place their grid is decided. Replicas need that size too, otherwise
  // they render the pane at a default grid that does not match its content.
  mirrorTerminalSize(terminalId, nextCols, nextRows);

  // Geometry decisions taken here are a common cause of a pane drawing wrong,
  // so they belong in the recording next to the bytes.
  if (instance.xterm.cols !== nextCols || instance.xterm.rows !== nextRows) {
    recordSessionEvent("frontend-resize", {
      terminalId,
      from: { cols: instance.xterm.cols, rows: instance.xterm.rows },
      to: { cols: nextCols, rows: nextRows },
      backendKind: getTerminalBackendKind(terminalId),
    });
  }
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
  markTerminalStatusResizeSuppression(terminalId, "frontend-grid-resize");
  instance.xterm.resize(nextCols, nextRows);
}

/** Text smaller than this is not worth rendering on a phone. */
const MIN_READABLE_FONT_SIZE = 11;
/** How much of the font size a row occupies, including line height. */
const ROW_HEIGHT_RATIO = 1.2;

/**
 * Size the font for a narrow screen.
 *
 * A replica renders the column count the desktop is running, which on a phone
 * is far wider than the display. Reflowing is not an option — the desktop owns
 * the grid, and reflowing would disagree with what it shows — so this client
 * changes its own font size instead. Scaling the font rather than
 * CSS-transforming the element keeps xterm's geometry honest, so taps still
 * land on the cell the user aimed at.
 *
 * Two ways to lose:
 *
 * - `readable` keeps text legible and fills the height, letting long lines run
 *   off the side to be panned to. Better for reading output, which is what a
 *   phone is mostly for.
 * - `fit-width` shrinks until every column is on screen, however small.
 */
export function fitTerminalFontToViewport(terminalId: string) {
  const instance = instances.get(terminalId);
  if (!instance) {
    return;
  }

  const preferredSize = useFontStore.getState().fontSize;
  if (!isCompactViewport()) {
    if (instance.xterm.options.fontSize !== preferredSize) {
      instance.xterm.options.fontSize = preferredSize;
    }
    return;
  }

  const mount = instance.element.parentElement;
  const currentSize = instance.xterm.options.fontSize ?? preferredSize;
  const cell = getTerminalCellSize(terminalId);
  const cols = instance.xterm.cols;
  const rows = instance.xterm.rows;
  if (!mount || !cell || cell.width <= 0 || cols <= 0 || rows <= 0) {
    return;
  }

  const fit = useUiStore.getState().compactTerminalFit;
  let nextSize: number;

  if (fit === "fit-width") {
    // Cell width scales with font size, so one measurement gives the ratio.
    const widthPerFontUnit = cell.width / currentSize;
    const available = mount.clientWidth;
    if (available <= 0) {
      return;
    }
    nextSize = Math.max(4, Math.min(preferredSize, Math.floor(available / (cols * widthPerFontUnit))));
  } else {
    const available = mount.clientHeight;
    if (available <= 0) {
      return;
    }
    const heightFitted = Math.floor(available / (rows * ROW_HEIGHT_RATIO));
    nextSize = Math.max(MIN_READABLE_FONT_SIZE, Math.min(preferredSize, heightFitted));
  }

  if (nextSize !== currentSize) {
    instance.xterm.options.fontSize = nextSize;
  }

  // xterm clips to its element, so in readable mode the columns that do not fit
  // would simply be unreachable. Widen the element to the whole grid and let
  // the pane scroll it instead.
  const widthPerFontUnit = cell.width / currentSize;
  const gridWidth = Math.ceil(cols * widthPerFontUnit * nextSize);
  const shouldOverflow = fit === "readable" && gridWidth > mount.clientWidth;
  instance.element.style.width = shouldOverflow ? `${gridWidth}px` : "";
  instance.element.style.flexShrink = shouldOverflow ? "0" : "";
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

  // Control chords (Ctrl+C, Ctrl+R, ⌘⌫ …) reach the terminal through here
  // rather than through xterm's own key handling, so a replica has to relay
  // them just like ordinary typing — it cannot write to the PTY itself.
  if (isReplicaClient()) {
    performAction("terminalInput", terminalId, data);
    return;
  }

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
  disposeAttachWatchdog(terminalId);
  forgetMirroredTerminal(terminalId);
  disposeWriteBatch(terminalId);
  syntheticInputSuppressions.delete(terminalId);
  focusSequenceSuppressions.delete(terminalId);
  setTerminalPasteProgress(terminalId, null);
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
    attachHistoryScrollProxy(terminalId, inst, mountPoint);

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

      fitTerminalFontToViewport(terminalId);

      const backendKind = useTerminalStore.getState().sessions[terminalId]?.backendKind;
      if (shouldFitFrontendToViewport(backendKind)) {
        i.fitAddon.fit();
      } else if (i.xterm.rows > 0) {
        // tmux panes keep their grid size, but a pane coming back from the
        // parking lot can hold a stale rendered frame until the next output
        // arrives. Repaint from the buffer so the visible text is current.
        i.xterm.refresh(0, i.xterm.rows - 1);
      }
      // Only steal DOM focus if this terminal is the active one.
      // Without this guard, every pane calls focus() on mount and
      // the last-rendered pane wins — breaking focus restoration.
      if (useTerminalStore.getState().activeTerminalId === terminalId) {
        i.xterm.focus();
      }

      if (backendKind === "local" || backendKind === "tmux-transport") {
        syncBackendTerminalSize(terminalId, i.xterm.cols, i.xterm.rows);
      }
    });

    // Forward user input to PTY.
    const dataDisposable = inst.xterm.onData((data) => {
      getCurrentTerminalInputRouter()(terminalId, data);
    });

    // Handle resize
    const resizeDisposable = inst.xterm.onResize(({ cols, rows }) => {
      const backendKind = useTerminalStore.getState().sessions[terminalId]?.backendKind ?? "local";
      markTerminalStatusResizeSuppression(terminalId, "xterm-resize");
      if (backendKind === "local" || backendKind === "tmux-transport") {
        syncBackendTerminalSize(terminalId, cols, rows);
      }
    });

    // Sync all font properties from store whenever they change
    const unsubFont = useFontStore.subscribe((state) => {
      const i = instances.get(terminalId);
      if (i) {
        i.xterm.options.fontSize = state.fontSize;
        i.xterm.options.fontFamily = buildFontFamilyCSS(state.fontFamily);
        fitTerminalFontToViewport(terminalId);
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
          // tmux grids are sized by tmux, not fit(). A font change alters the
          // cell size, so the same grid no longer fits the mount — ask tmux
          // for a new client size or whole rows stay clipped below the fold.
          if (backendKind === "tmux-pane" && !syncTmuxWindowSizeFromPaneTerminal(terminalId)) {
            requestAnimationFrame(() => {
              syncTmuxWindowSizeFromPaneTerminal(terminalId);
            });
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
