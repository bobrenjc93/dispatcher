import type { LayoutNode } from "../types/layout";
import type { TreeNode } from "../types/project";
import type { TerminalSession } from "../types/terminal";
import { useLayoutStore } from "../stores/useLayoutStore";
import { useProjectStore } from "../stores/useProjectStore";
import { useTerminalStore } from "../stores/useTerminalStore";
import { buildLayoutFromTmuxPanes, type TmuxPaneLayoutRecord } from "./tmuxLayout";
import {
  TMUX_CONTROL_END,
  TMUX_CONTROL_START,
  buildTmuxNewWindowCommand,
  buildTmuxPaneCaptureCommand,
  buildTmuxPaneSnapshotCommand,
  buildTmuxWindowSnapshotCommand,
  encodeTmuxSendKeysHex,
  normalizeTmuxPasteBufferText,
  parseTmuxPaneSnapshot,
  parseTmuxWindowSnapshot,
  quoteTmuxCommandArgument,
  unescapeTmuxOutput,
  type TmuxPaneSnapshot,
  type TmuxWindowSnapshot,
} from "./tmuxControlProtocol";
import {
  buildPreferredTmuxWindowOrder,
  reconcileTmuxWindowNodePlacements,
  resolveAdjacentTmuxWindowAfterClose,
} from "./tmuxWindowOrder";
import { findLayoutKeyForTerminal, findTerminalIds } from "./layoutUtils";
import {
  findDisconnectedTmuxWindowPlaceholder,
  findNodeByTerminalId,
  findProjectIdForTerminal,
  findProjectIdForNode,
  type DisconnectedTmuxWindowPlaceholderRef,
} from "./treeUtils";
import { writeTerminal } from "./tauriCommands";
import { debugLog, debugLogError, previewDebugText } from "./debugLog";
import {
  disposeTerminalInstance,
  ensureTerminalFrontend,
  focusTerminalInstance,
  getTerminalCellSize,
  getTerminalViewportSize,
  queueTerminalOutput,
  syncTerminalFrontendSize,
} from "../hooks/useTerminalBridge";
import { computeTmuxWindowSizeFromPaneViewport } from "./tmuxSizing";
import {
  resolveRecoveredTmuxSessionPlacement,
  resolveTmuxWindowPlacementFromPlaceholder,
} from "./tmuxSessionPlacement";

interface PendingCommand {
  command: string;
  resolve: (lines: string[]) => void;
  reject: (error: Error) => void;
}

interface CommandCapture {
  pending: PendingCommand | null;
  lines: string[];
}

interface PendingNewWindowAnchor {
  token: string;
  anchorWindowId: string;
}

interface TmuxWindowState {
  windowId: string;
  terminalId: string;
  nodeId: string;
  title: string;
  flags: string;
  activePaneId: string | null;
}

interface TmuxPaneState {
  paneId: string;
  windowId: string;
  terminalId: string;
  left: number;
  top: number;
  width: number;
  height: number;
  isActive: boolean;
  cwd?: string;
  cursorX: number;
  cursorY: number;
  alternateOn: boolean;
  historySize: number;
  initialContentCaptured: boolean;
  lastHistoryCaptureSize: number;
  lastHistoryRefreshAt: number;
  lastHistoryRefreshDeferredLogAt: number;
  historyCaptureInFlight: boolean;
  missedOutputSinceHistoryCapture: boolean;
  contentClearGeneration: number;
}

interface WindowProjectionResult {
  changedPaneIds: Set<string>;
}

interface TmuxControlSession {
  id: string;
  transportTerminalId: string;
  projectId: string;
  transportProjectId: string;
  transportNodeId: string;
  parentNodeId: string;
  transportParentNodeId: string;
  transportTitle: string;
  transportNotes: string;
  transportMetadataAdopted: boolean;
  controlModeActive: boolean;
  lineBuffer: string;
  pendingCommands: PendingCommand[];
  currentCommand: CommandCapture | null;
  windows: Map<string, TmuxWindowState>;
  panes: Map<string, TmuxPaneState>;
  windowOrder: string[];
  refreshTimer: number | null;
  pendingWindowRefreshes: Set<string>;
  fullRefreshPending: boolean;
  hydrationPromise: Promise<void> | null;
  bootstrapRefreshTimer: number | null;
  pendingNewWindowAnchors: PendingNewWindowAnchor[];
  pendingNewWindowActivations: Map<string, string>;
  windowSizes: Map<string, string>;
  clientSize: string | null;
  clientResizeLayoutSuppressionWindowId: string | null;
  clientResizeLayoutSuppressionUntil: number;
  clientResizeLayoutSuppressedCount: number;
  pendingWindowRedraws: Set<string>;
  userPaneResizeLocks: Map<string, number>;
  outputLogCount: number;
  outputLogSuppressed: boolean;
  transportLogCount: number;
  transportLogSuppressed: boolean;
  transportSummaryChunks: number;
  transportSummaryBytes: number;
  transportSummaryPassthroughBytes: number;
  transportSummaryLastLoggedAt: number;
  needsBootstrapRefresh: boolean;
  pendingPaneOutput: Map<string, string[]>;
  pendingInitialPaneCaptures: string[];
  initialPaneCaptureTimer: number | null;
  initialPaneCaptureActive: boolean;
  paneOutputActivitySuppressionUntil: Map<string, number>;
  suppressedPaneOutputActivitySummaries: Map<string, SuppressedPaneOutputActivitySummary>;
}

interface SuppressedPaneOutputActivitySummary {
  chunks: number;
  bytes: number;
  firstPreview: string;
  lastPreview: string;
  lastLoggedAt: number;
}

interface TmuxRuntimeState {
  controlSessions: Map<string, TmuxControlSession>;
  paneTerminalToSessionId: Map<string, string>;
  windowTerminalToSessionId: Map<string, string>;
  transportTerminalToSessionId: Map<string, string>;
  transportRawCarry: Map<string, string>;
}

declare global {
  // eslint-disable-next-line no-var
  var __dispatcherTmuxRuntimeState: TmuxRuntimeState | undefined;
}

function generateId(): string {
  return crypto.randomUUID();
}

function getTmuxRuntimeState(): TmuxRuntimeState {
  if (globalThis.__dispatcherTmuxRuntimeState) {
    debugLog("tmux.runtime", "reuse", {
      controlSessions: globalThis.__dispatcherTmuxRuntimeState.controlSessions.size,
      paneBindings: globalThis.__dispatcherTmuxRuntimeState.paneTerminalToSessionId.size,
      windowBindings: globalThis.__dispatcherTmuxRuntimeState.windowTerminalToSessionId.size,
      transportBindings: globalThis.__dispatcherTmuxRuntimeState.transportTerminalToSessionId.size,
    });
    return globalThis.__dispatcherTmuxRuntimeState;
  }

  const created: TmuxRuntimeState = {
    controlSessions: new Map<string, TmuxControlSession>(),
    paneTerminalToSessionId: new Map<string, string>(),
    windowTerminalToSessionId: new Map<string, string>(),
    transportTerminalToSessionId: new Map<string, string>(),
    transportRawCarry: new Map<string, string>(),
  };
  globalThis.__dispatcherTmuxRuntimeState = created;
  debugLog("tmux.runtime", "initialize", {
    controlSessions: 0,
    paneBindings: 0,
    windowBindings: 0,
    transportBindings: 0,
  });
  return created;
}

const tmuxRuntime = getTmuxRuntimeState();
const controlSessions = tmuxRuntime.controlSessions;
const paneTerminalToSessionId = tmuxRuntime.paneTerminalToSessionId;
const windowTerminalToSessionId = tmuxRuntime.windowTerminalToSessionId;
const transportTerminalToSessionId = tmuxRuntime.transportTerminalToSessionId;
const transportRawCarry = tmuxRuntime.transportRawCarry;
const TMUX_OUTPUT_LOG_LIMIT = 25;
const TMUX_TRANSPORT_LOG_LIMIT = 25;
const TMUX_TRANSPORT_SUMMARY_INTERVAL_MS = 5_000;
const TMUX_BOOTSTRAP_FALLBACK_DELAY_MS = 100;
const TMUX_USER_PANE_RESIZE_LOCK_MS = 4_000;
const TMUX_INITIAL_CAPTURE_BACKGROUND_DELAY_MS = 250;
const TMUX_INITIAL_CAPTURE_RETRY_DELAY_MS = 50;
const TMUX_PENDING_PANE_OUTPUT_MAX_CHUNKS = 512;
const TMUX_PENDING_PANE_OUTPUT_MAX_CHARS = 2_000_000;
const TMUX_CLIENT_RESIZE_LAYOUT_SUPPRESSION_MS = 1_000;
const TMUX_PANE_OUTPUT_ACTIVITY_SUPPRESSION_MS = 2_000;
const TMUX_SUPPRESSED_ACTIVITY_SUMMARY_INTERVAL_MS = 5_000;
const TMUX_HISTORY_REFRESH_COOLDOWN_MS = 30_000;
const TMUX_HISTORY_REFRESH_DEFER_LOG_INTERVAL_MS = 10_000;
const TMUX_PASTE_BUFFER_CHUNK_SIZE = 8_000;
const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";
let tmuxPasteBufferSequence = 0;
const TMUX_CONTROL_LINE_PREFIXES = [
  "%begin",
  "%client-",
  "%end",
  "%error",
  "%exit",
  "%extended-output",
  "%layout-change",
  "%output",
  "%pane-",
  "%session",
  "%sessions-",
  "%unlinked-window-",
  "%window-",
] as const;
const TMUX_CONTROL_LINE_PATTERN =
  /(?:^|[\r\n])(%(?:begin|client-|end|error|exit|extended-output|layout-change|output|pane-|session|sessions-|unlinked-window-|window-)(?:\s|$))/;

function ensureInitialPaneCaptureState(session: TmuxControlSession) {
  session.pendingInitialPaneCaptures ??= [];
  session.initialPaneCaptureTimer ??= null;
  session.initialPaneCaptureActive ??= false;
}

function ensurePaneHistoryCaptureState(pane: TmuxPaneState) {
  pane.lastHistoryCaptureSize ??= 0;
  pane.lastHistoryRefreshAt ??= 0;
  pane.lastHistoryRefreshDeferredLogAt ??= 0;
  pane.historyCaptureInFlight ??= false;
  pane.missedOutputSinceHistoryCapture ??= false;
  pane.contentClearGeneration ??= 0;
}

function ensurePaneOutputActivitySuppressionState(session: TmuxControlSession) {
  session.paneOutputActivitySuppressionUntil ??= new Map();
  session.suppressedPaneOutputActivitySummaries ??= new Map();
}

function ensureTransportLogState(session: TmuxControlSession) {
  session.transportLogCount ??= 0;
  session.transportLogSuppressed ??= false;
  session.transportSummaryChunks ??= 0;
  session.transportSummaryBytes ??= 0;
  session.transportSummaryPassthroughBytes ??= 0;
  session.transportSummaryLastLoggedAt ??= 0;
}

function ensureTmuxClientSizeState(session: TmuxControlSession) {
  session.clientSize ??= null;
  session.clientResizeLayoutSuppressionWindowId ??= null;
  session.clientResizeLayoutSuppressionUntil ??= 0;
  session.clientResizeLayoutSuppressedCount ??= 0;
}

function suppressPaneOutputActivity(
  session: TmuxControlSession,
  paneId: string,
  reason: string
) {
  ensurePaneOutputActivitySuppressionState(session);
  const now = Date.now();
  const expiresAt = now + TMUX_PANE_OUTPUT_ACTIVITY_SUPPRESSION_MS;
  const previousExpiresAt = session.paneOutputActivitySuppressionUntil.get(paneId) ?? 0;
  session.paneOutputActivitySuppressionUntil.set(
    paneId,
    Math.max(previousExpiresAt, expiresAt)
  );
  debugLog("tmux.activity", "suppress pane output activity", {
    sessionId: session.id,
    paneId,
    reason,
    expiresAt,
  });
}

function suppressWindowOutputActivity(
  session: TmuxControlSession,
  windowId: string,
  reason: string
) {
  for (const pane of session.panes.values()) {
    if (pane.windowId === windowId) {
      suppressPaneOutputActivity(session, pane.paneId, reason);
    }
  }
}

function shouldRecordPaneOutputActivity(session: TmuxControlSession, paneId: string): boolean {
  ensurePaneOutputActivitySuppressionState(session);
  const expiresAt = session.paneOutputActivitySuppressionUntil.get(paneId) ?? 0;
  if (expiresAt <= 0) {
    return true;
  }

  const now = Date.now();
  if (now <= expiresAt) {
    return false;
  }

  session.paneOutputActivitySuppressionUntil.delete(paneId);
  return true;
}

function recordSuppressedPaneOutputActivity(
  session: TmuxControlSession,
  pane: TmuxPaneState,
  value: string
) {
  ensurePaneOutputActivitySuppressionState(session);

  const now = Date.now();
  const preview = previewDebugText(value, 120);
  let summary = session.suppressedPaneOutputActivitySummaries.get(pane.paneId);
  if (!summary) {
    summary = {
      chunks: 0,
      bytes: 0,
      firstPreview: preview,
      lastPreview: preview,
      lastLoggedAt: now,
    };
    session.suppressedPaneOutputActivitySummaries.set(pane.paneId, summary);
  }

  if (summary.chunks === 0) {
    summary.firstPreview = preview;
  }
  summary.chunks += 1;
  summary.bytes += value.length;
  summary.lastPreview = preview;

  if (now - summary.lastLoggedAt < TMUX_SUPPRESSED_ACTIVITY_SUMMARY_INTERVAL_MS) {
    return;
  }

  debugLog("tmux.activity", "suppressed output activity summary", {
    sessionId: session.id,
    paneId: pane.paneId,
    terminalId: pane.terminalId,
    chunks: summary.chunks,
    bytes: summary.bytes,
    intervalMs: now - summary.lastLoggedAt,
    firstPreview: summary.firstPreview,
    lastPreview: summary.lastPreview,
  });

  summary.chunks = 0;
  summary.bytes = 0;
  summary.firstPreview = "";
  summary.lastPreview = preview;
  summary.lastLoggedAt = now;
}

function markTmuxClientSize(session: TmuxControlSession, nextSize: string) {
  ensureTmuxClientSizeState(session);
  session.clientSize = nextSize;
  for (const windowState of session.windows.values()) {
    session.windowSizes.set(windowState.windowId, nextSize);
  }
}

function beginTmuxClientResizeLayoutSuppression(
  session: TmuxControlSession,
  targetWindowId: string
) {
  ensureTmuxClientSizeState(session);
  session.clientResizeLayoutSuppressionWindowId = targetWindowId;
  session.clientResizeLayoutSuppressionUntil = Date.now() + TMUX_CLIENT_RESIZE_LAYOUT_SUPPRESSION_MS;
  session.clientResizeLayoutSuppressedCount = 0;
}

function shouldSuppressTmuxLayoutChange(
  session: TmuxControlSession,
  windowId: string
): boolean {
  ensureTmuxClientSizeState(session);
  const targetWindowId = session.clientResizeLayoutSuppressionWindowId;
  if (!targetWindowId) {
    return false;
  }

  if (Date.now() > session.clientResizeLayoutSuppressionUntil) {
    session.clientResizeLayoutSuppressionWindowId = null;
    session.clientResizeLayoutSuppressionUntil = 0;
    session.clientResizeLayoutSuppressedCount = 0;
    return false;
  }

  if (windowId === targetWindowId || !session.windows.has(windowId)) {
    return false;
  }

  session.clientResizeLayoutSuppressedCount += 1;
  if (
    session.clientResizeLayoutSuppressedCount <= 3
    || session.clientResizeLayoutSuppressedCount === 10
  ) {
    debugLog("tmux.refresh", "suppress background layout change during client resize", {
      sessionId: session.id,
      windowId,
      targetWindowId,
      suppressedCount: session.clientResizeLayoutSuppressedCount,
    });
  }
  return true;
}

function maybeLogTmuxTransportSummary(
  session: TmuxControlSession,
  terminalId: string,
  remainingCarryLength?: number
) {
  ensureTransportLogState(session);
  if (!session.transportLogSuppressed) {
    return;
  }

  const now = Date.now();
  if (session.transportSummaryLastLoggedAt <= 0) {
    session.transportSummaryLastLoggedAt = now;
    return;
  }
  if (now - session.transportSummaryLastLoggedAt < TMUX_TRANSPORT_SUMMARY_INTERVAL_MS) {
    return;
  }

  debugLog("tmux.transport", "chunk summary", {
    sessionId: session.id,
    terminalId,
    chunks: session.transportSummaryChunks,
    bytes: session.transportSummaryBytes,
    passthroughBytes: session.transportSummaryPassthroughBytes,
    remainingCarryLength: remainingCarryLength ?? null,
    intervalMs: now - session.transportSummaryLastLoggedAt,
  });
  session.transportSummaryChunks = 0;
  session.transportSummaryBytes = 0;
  session.transportSummaryPassthroughBytes = 0;
  session.transportSummaryLastLoggedAt = now;
}

function debugTmuxTransportChunk(
  session: TmuxControlSession,
  terminalId: string,
  data: string,
  carryLength: number,
  existingSessionId: string | null
) {
  ensureTransportLogState(session);
  session.transportSummaryChunks += 1;
  session.transportSummaryBytes += data.length;

  if (session.transportLogCount < TMUX_TRANSPORT_LOG_LIMIT) {
    session.transportLogCount += 1;
    debugLog("tmux.transport", "chunk", {
      terminalId,
      existingSessionId,
      carryLength,
      bytes: data.length,
      preview: previewDebugText(data, 200),
    });
    return;
  }

  if (!session.transportLogSuppressed) {
    session.transportLogSuppressed = true;
    session.transportSummaryChunks = 0;
    session.transportSummaryBytes = 0;
    session.transportSummaryPassthroughBytes = 0;
    session.transportSummaryLastLoggedAt = Date.now();
    debugLog("tmux.transport", "chunk logging suppressed", {
      sessionId: session.id,
      terminalId,
      limit: TMUX_TRANSPORT_LOG_LIMIT,
      summaryIntervalMs: TMUX_TRANSPORT_SUMMARY_INTERVAL_MS,
    });
    return;
  }

  maybeLogTmuxTransportSummary(session, terminalId);
}

function recordTmuxTransportComplete(
  session: TmuxControlSession,
  terminalId: string,
  passthroughBytes: number,
  remainingCarryLength: number
) {
  ensureTransportLogState(session);
  session.transportSummaryPassthroughBytes += passthroughBytes;
  maybeLogTmuxTransportSummary(session, terminalId, remainingCarryLength);
}

function isGenericDispatcherTitle(title: string): boolean {
  return title === "Shell" || /^Terminal \d+$/.test(title);
}

function getMarkerCarry(input: string, marker: string): string {
  const maxLength = Math.min(input.length, marker.length - 1);
  for (let length = maxLength; length > 0; length -= 1) {
    if (marker.startsWith(input.slice(-length))) {
      return input.slice(-length);
    }
  }
  return "";
}

function findTmuxControlLineStart(input: string): number {
  const match = TMUX_CONTROL_LINE_PATTERN.exec(input);
  if (!match) {
    return -1;
  }

  return match.index + match[0].indexOf("%");
}

function getBareTmuxControlCarry(input: string): string {
  const lastLineBreakIndex = Math.max(input.lastIndexOf("\n"), input.lastIndexOf("\r"));
  const suffix = input.slice(lastLineBreakIndex + 1);
  if (!suffix.startsWith("%")) {
    return "";
  }

  return TMUX_CONTROL_LINE_PREFIXES.some((prefix) => prefix.startsWith(suffix))
    ? suffix
    : "";
}

function getTransportControlStartCarry(input: string): string {
  const dcsCarry = getMarkerCarry(input, TMUX_CONTROL_START);
  const bareCarry = getBareTmuxControlCarry(input);
  return bareCarry.length > dcsCarry.length ? bareCarry : dcsCarry;
}

function getTerminalSession(terminalId: string): TerminalSession | undefined {
  return useTerminalStore.getState().sessions[terminalId];
}

function pushPendingPaneOutput(session: TmuxControlSession, paneId: string, value: string) {
  const buffer = session.pendingPaneOutput.get(paneId) ?? [];
  buffer.push(value);

  let totalChars = buffer.reduce((total, chunk) => total + chunk.length, 0);
  let droppedChunks = 0;
  while (
    buffer.length > TMUX_PENDING_PANE_OUTPUT_MAX_CHUNKS
    || totalChars > TMUX_PENDING_PANE_OUTPUT_MAX_CHARS
  ) {
    const removed = buffer.shift();
    if (removed === undefined) {
      break;
    }
    totalChars -= removed.length;
    droppedChunks += 1;
  }

  session.pendingPaneOutput.set(paneId, buffer);
  return {
    chunks: buffer.length,
    totalChars,
    droppedChunks,
  };
}

function recoverControlSessionFromStore(sessionId: string): TmuxControlSession | null {
  const existing = controlSessions.get(sessionId);
  if (existing) {
    return existing;
  }

  const terminalState = useTerminalStore.getState();
  const transportSession = terminalState.sessions[sessionId];
  if (!transportSession || transportSession.backendKind !== "tmux-transport") {
    return null;
  }

  const projectState = useProjectStore.getState();
  const transportNodeEntry = findNodeByTerminalId(projectState.nodes, sessionId);
  const projectId = findProjectIdForTerminal(
    projectState.projects,
    projectState.projectOrder,
    projectState.nodes,
    terminalState.sessions,
    sessionId
  );

  if (!transportNodeEntry || !transportNodeEntry.node.parentId || !projectId) {
    debugLog("tmux.runtime", "recover failed", {
      sessionId,
      reason: "missing-transport-context",
      hasTransportNode: Boolean(transportNodeEntry),
      parentNodeId: transportNodeEntry?.node.parentId ?? null,
      projectId: projectId ?? null,
    });
    return null;
  }

  let recoveredWindowProjectId: string | null = null;
  let recoveredWindowParentNodeId: string | null = null;

  const recovered: TmuxControlSession = {
    id: sessionId,
    transportTerminalId: sessionId,
    projectId,
    transportProjectId: projectId,
    transportNodeId: transportNodeEntry.nodeId,
    parentNodeId: transportNodeEntry.node.parentId,
    transportParentNodeId: transportNodeEntry.node.parentId,
    transportTitle: transportSession.title,
    transportNotes: transportSession.notes,
    transportMetadataAdopted: true,
    controlModeActive: true,
    lineBuffer: "",
    pendingCommands: [],
    currentCommand: null,
    windows: new Map(),
    panes: new Map(),
    windowOrder: [],
    refreshTimer: null,
    pendingWindowRefreshes: new Set(),
    fullRefreshPending: false,
    hydrationPromise: null,
    bootstrapRefreshTimer: null,
    pendingNewWindowAnchors: [],
    pendingNewWindowActivations: new Map(),
    windowSizes: new Map(),
    clientSize: null,
    clientResizeLayoutSuppressionWindowId: null,
    clientResizeLayoutSuppressionUntil: 0,
    clientResizeLayoutSuppressedCount: 0,
    pendingWindowRedraws: new Set(),
    userPaneResizeLocks: new Map(),
    outputLogCount: 0,
    outputLogSuppressed: false,
    transportLogCount: 0,
    transportLogSuppressed: false,
    transportSummaryChunks: 0,
    transportSummaryBytes: 0,
    transportSummaryPassthroughBytes: 0,
    transportSummaryLastLoggedAt: 0,
    needsBootstrapRefresh: false,
    pendingPaneOutput: new Map(),
    pendingInitialPaneCaptures: [],
    initialPaneCaptureTimer: null,
    initialPaneCaptureActive: false,
    paneOutputActivitySuppressionUntil: new Map(),
    suppressedPaneOutputActivitySummaries: new Map(),
  };

  for (const [nodeId, node] of Object.entries(projectState.nodes)) {
    if (node.type !== "terminal" || !node.terminalId) {
      continue;
    }

    const session = terminalState.sessions[node.terminalId];
    if (
      !session
      || session.backendKind !== "tmux-window"
      || session.tmuxControlSessionId !== sessionId
      || !session.tmuxWindowId
    ) {
      continue;
    }

    recovered.windows.set(session.tmuxWindowId, {
      windowId: session.tmuxWindowId,
      terminalId: session.id,
      nodeId,
      title: session.title,
      flags: "",
      activePaneId: null,
    });
    windowTerminalToSessionId.set(session.id, sessionId);

    if (!recoveredWindowParentNodeId && node.parentId) {
      recoveredWindowParentNodeId = node.parentId;
    }
    if (!recoveredWindowProjectId) {
      recoveredWindowProjectId = findProjectIdForNode(
        projectState.projects,
        projectState.projectOrder,
        projectState.nodes,
        nodeId
      );
    }
  }

  for (const session of Object.values(terminalState.sessions)) {
    if (
      session.backendKind !== "tmux-pane"
      || session.tmuxControlSessionId !== sessionId
      || !session.tmuxWindowId
      || !session.tmuxPaneId
    ) {
      continue;
    }

    recovered.panes.set(session.tmuxPaneId, {
      paneId: session.tmuxPaneId,
      windowId: session.tmuxWindowId,
      terminalId: session.id,
      left: 0,
      top: 0,
      width: 0,
      height: 0,
      isActive: false,
      cwd: session.cwd,
      cursorX: 0,
      cursorY: 0,
      alternateOn: false,
      historySize: 0,
      initialContentCaptured: false,
      lastHistoryCaptureSize: 0,
      lastHistoryRefreshAt: 0,
      lastHistoryRefreshDeferredLogAt: 0,
      historyCaptureInFlight: false,
      missedOutputSinceHistoryCapture: false,
      contentClearGeneration: 0,
    });
    paneTerminalToSessionId.set(session.id, sessionId);

    const window = recovered.windows.get(session.tmuxWindowId);
    if (window && !window.activePaneId) {
      window.activePaneId = session.tmuxPaneId;
    }
  }

  if (recovered.windows.size === 0) {
    debugLog("tmux.runtime", "recover failed", {
      sessionId,
      reason: "missing-window-bindings",
      paneCount: recovered.panes.size,
    });
    return null;
  }

  const recoveredPlacement = resolveRecoveredTmuxSessionPlacement({
    transportProjectId: projectId,
    transportParentNodeId: transportNodeEntry.node.parentId,
    windowProjectId: recoveredWindowProjectId,
    windowParentNodeId: recoveredWindowParentNodeId,
  });
  recovered.projectId = recoveredPlacement.projectId;
  recovered.parentNodeId = recoveredPlacement.parentNodeId;

  const parentChildren = projectState.nodes[recovered.parentNodeId]?.children ?? [];
  recovered.windowOrder = buildPreferredTmuxWindowOrder({
    currentChildren: parentChildren,
    windows: [...recovered.windows.values()].map((window) => ({
      windowId: window.windowId,
      nodeId: window.nodeId,
    })),
    snapshotWindowOrder: [...recovered.windows.keys()],
  });

  controlSessions.set(recovered.id, recovered);
  transportTerminalToSessionId.set(recovered.transportTerminalId, recovered.id);
  transportRawCarry.set(recovered.transportTerminalId, transportRawCarry.get(recovered.transportTerminalId) ?? "");

  debugLog("tmux.runtime", "recover from store", {
    sessionId,
    transportTerminalId: recovered.transportTerminalId,
    transportProjectId: recovered.transportProjectId,
    transportParentNodeId: recovered.transportParentNodeId,
    projectId: recovered.projectId,
    parentNodeId: recovered.parentNodeId,
    windows: recovered.windows.size,
    panes: recovered.panes.size,
    windowOrder: recovered.windowOrder,
  });

  return recovered;
}

function getControlSessionById(sessionId: string | undefined): TmuxControlSession | null {
  if (!sessionId) {
    return null;
  }
  const session = controlSessions.get(sessionId) ?? recoverControlSessionFromStore(sessionId);
  if (session) {
    ensureInitialPaneCaptureState(session);
    ensurePaneOutputActivitySuppressionState(session);
  }
  return session;
}

function getControlSessionForTerminal(terminalId: string): TmuxControlSession | null {
  const terminal = getTerminalSession(terminalId);
  return getControlSessionById(terminal?.tmuxControlSessionId);
}

function getTmuxWindowStateByTerminal(terminalId: string): TmuxWindowState | null {
  const session = getControlSessionForTerminal(terminalId);
  if (!session) {
    return null;
  }
  const terminal = getTerminalSession(terminalId);
  if (!terminal?.tmuxWindowId) {
    return null;
  }
  return session.windows.get(terminal.tmuxWindowId) ?? null;
}

function getTmuxPaneStateByTerminal(terminalId: string): TmuxPaneState | null {
  const session = getControlSessionForTerminal(terminalId);
  if (!session) {
    return null;
  }
  const terminal = getTerminalSession(terminalId);
  if (!terminal?.tmuxPaneId) {
    return null;
  }
  return session.panes.get(terminal.tmuxPaneId) ?? null;
}

function addSessionWithoutActivating(session: TerminalSession) {
  useTerminalStore.setState((state) => ({
    sessions: {
      ...state.sessions,
      [session.id]: session,
    },
  }));
}

function addOrUpdateTreeNode(nodeId: string, node: TreeNode) {
  useProjectStore.setState((state) => ({
    nodes: {
      ...state.nodes,
      [nodeId]: node,
    },
  }));
}

function setLayout(layoutId: string, layout: LayoutNode) {
  useLayoutStore.setState((state) => ({
    layouts: {
      ...state.layouts,
      [layoutId]: layout,
    },
  }));
}

function lockTmuxWindowForUserPaneResize(
  session: TmuxControlSession,
  windowId: string,
  reason: string
) {
  const expiresAt = Date.now() + TMUX_USER_PANE_RESIZE_LOCK_MS;
  const previousExpiresAt = session.userPaneResizeLocks.get(windowId) ?? 0;
  session.userPaneResizeLocks.set(windowId, Math.max(previousExpiresAt, expiresAt));
  debugLog("tmux.resize", "user pane resize lock", {
    sessionId: session.id,
    windowId,
    reason,
    previousExpiresAt,
    expiresAt: session.userPaneResizeLocks.get(windowId),
  });
}

function clearTmuxWindowUserPaneResizeLock(
  session: TmuxControlSession,
  windowId: string,
  reason: string
) {
  if (!session.userPaneResizeLocks.delete(windowId)) {
    return;
  }

  debugLog("tmux.resize", "user pane resize unlock", {
    sessionId: session.id,
    windowId,
    reason,
  });
}

function isTmuxWindowUserPaneResizeLocked(
  session: TmuxControlSession,
  windowId: string
): boolean {
  const expiresAt = session.userPaneResizeLocks.get(windowId) ?? 0;
  if (expiresAt === 0) {
    return false;
  }

  if (expiresAt <= Date.now()) {
    session.userPaneResizeLocks.delete(windowId);
    debugLog("tmux.resize", "user pane resize lock expired", {
      sessionId: session.id,
      windowId,
      expiresAt,
    });
    return false;
  }

  return true;
}

function findDisconnectedWindowPlaceholder(
  session: TmuxControlSession,
  windowId: string,
  title?: string
): DisconnectedTmuxWindowPlaceholderRef | null {
  const projectState = useProjectStore.getState();
  const terminalState = useTerminalStore.getState();
  const allCandidates = Object.entries(terminalState.sessions)
    .filter(([, s]) =>
      s.backendKind === "tmux-window"
      && !s.tmuxControlSessionId
      && s.tmuxWindowId === windowId
    )
    .map(([id, s]) => {
      const node = findNodeByTerminalId(projectState.nodes, id);
      return {
        terminalId: id,
        title: s.title,
        nodeId: node?.nodeId ?? null,
        parentNodeId: node?.node.parentId ?? null,
      };
    });
  if (allCandidates.length > 0) {
    debugLog("tmux.session", "placeholder candidates", {
      sessionId: session.id,
      windowId,
      title: title ?? null,
      sessionParentNodeId: session.parentNodeId,
      sessionProjectId: session.projectId,
      candidates: allCandidates,
    });
  }
  const placeholder = findDisconnectedTmuxWindowPlaceholder(
    projectState.projects,
    projectState.projectOrder,
    projectState.nodes,
    terminalState.sessions,
    windowId,
    {
      parentNodeId: session.parentNodeId,
      projectId: session.projectId,
      title,
    }
  );
  if (!placeholder) {
    return null;
  }

  const nextPlacement = resolveTmuxWindowPlacementFromPlaceholder({
    currentProjectId: session.projectId,
    currentParentNodeId: session.parentNodeId,
    existingWindowCount: session.windows.size,
    placeholderProjectId: placeholder.projectId,
    placeholderParentNodeId: placeholder.parentNodeId,
  });
  if (nextPlacement.adopted) {
    debugLog("tmux.session", "adopt disconnected window placement", {
      sessionId: session.id,
      windowId,
      title: title ?? null,
      nodeId: placeholder.nodeId,
      terminalId: placeholder.terminalId,
      fromTransportParentNodeId: session.transportParentNodeId,
      fromTransportProjectId: session.transportProjectId,
      toParentNodeId: nextPlacement.parentNodeId,
      toProjectId: nextPlacement.projectId,
    });
    session.parentNodeId = nextPlacement.parentNodeId;
    session.projectId = nextPlacement.projectId;
  }

  return placeholder;
}

function getDisconnectedPanePlaceholders(
  windowTerminalId: string,
  windowId: string
): Map<string, string> {
  const layouts = useLayoutStore.getState().layouts;
  const layout = layouts[windowTerminalId];
  if (!layout) {
    return new Map();
  }

  const placeholders = new Map<string, string>();
  for (const terminalId of findTerminalIds(layout)) {
    const terminal = getTerminalSession(terminalId);
    if (
      terminal?.backendKind === "tmux-pane"
      && !terminal.tmuxControlSessionId
      && terminal.tmuxWindowId === windowId
      && terminal.tmuxPaneId
    ) {
      placeholders.set(terminal.tmuxPaneId, terminalId);
    }
  }

  return placeholders;
}

function hasDisconnectedWindowPlaceholder(windowId: string): boolean {
  return Object.values(useTerminalStore.getState().sessions).some((session) =>
    session.backendKind === "tmux-window"
    && !session.tmuxControlSessionId
    && session.tmuxWindowId === windowId
  );
}

function removeWindowNodeFromParent(parentNodeId: string, nodeId: string) {
  const parent = useProjectStore.getState().nodes[parentNodeId];
  if (!parent?.children) {
    return;
  }

  useProjectStore.setState((state) => ({
    nodes: {
      ...state.nodes,
      [parentNodeId]: {
        ...state.nodes[parentNodeId],
        children: (state.nodes[parentNodeId].children ?? []).filter((childId) => childId !== nodeId),
      },
    },
  }));
}

function removeWindowNodeFromAllParents(nodeId: string) {
  const projectState = useProjectStore.getState();
  const parentNodeIds = Object.entries(projectState.nodes)
    .filter(([, node]) => node.children?.includes(nodeId))
    .map(([parentNodeId]) => parentNodeId);

  if (parentNodeIds.length === 0) {
    return;
  }

  useProjectStore.setState((state) => {
    const nodes = { ...state.nodes };
    for (const parentNodeId of parentNodeIds) {
      const parent = nodes[parentNodeId];
      if (!parent?.children) {
        continue;
      }
      nodes[parentNodeId] = {
        ...parent,
        children: parent.children.filter((childId) => childId !== nodeId),
      };
    }
    return { nodes };
  });
}

function getWindowPlacement(session: TmuxControlSession, window: TmuxWindowState): {
  parentNodeId: string;
  projectId: string;
} {
  const projectState = useProjectStore.getState();
  const node = projectState.nodes[window.nodeId];
  const parentNodeId = node?.parentId ?? session.parentNodeId;
  const projectId = findProjectIdForNode(
    projectState.projects,
    projectState.projectOrder,
    projectState.nodes,
    node ? window.nodeId : parentNodeId
  ) ?? session.projectId;

  return { parentNodeId, projectId };
}

function adoptSessionPlacementFromWindow(session: TmuxControlSession, window: TmuxWindowState) {
  const placement = getWindowPlacement(session, window);
  session.parentNodeId = placement.parentNodeId;
  session.projectId = placement.projectId;
  return placement;
}

function insertWindowIdAfterAnchor(
  windowOrder: readonly string[],
  windowId: string,
  anchorWindowId: string | null
): string[] {
  const order = windowOrder.filter((id) => id !== windowId);
  const anchorIndex = anchorWindowId ? order.indexOf(anchorWindowId) : -1;
  const insertIndex = anchorIndex === -1 ? order.length : anchorIndex + 1;
  order.splice(insertIndex, 0, windowId);
  return order;
}

function syncWindowNodeOrder(
  session: TmuxControlSession,
  options?: {
    preserveExistingSidebarOrder?: boolean;
  }
) {
  const projectState = useProjectStore.getState();

  const windowNodeIds = session.windowOrder
    .map((windowId) => session.windows.get(windowId)?.nodeId)
    .filter((nodeId): nodeId is string => Boolean(nodeId));

  if (windowNodeIds.length === 0) {
    return;
  }

  const windowNodeIdSet = new Set(windowNodeIds);
  const parentNodeIds = new Set<string>();
  const nodeParentByNodeId: Record<string, string | null | undefined> = {};

  for (const nodeId of windowNodeIds) {
    const parentNodeId = projectState.nodes[nodeId]?.parentId ?? session.parentNodeId;
    nodeParentByNodeId[nodeId] = parentNodeId;
    if (projectState.nodes[parentNodeId]?.children) {
      parentNodeIds.add(parentNodeId);
    }
  }

  for (const [parentNodeId, node] of Object.entries(projectState.nodes)) {
    if (node.children?.some((childId) => windowNodeIdSet.has(childId))) {
      parentNodeIds.add(parentNodeId);
    }
  }

  const currentChildrenByParentId: Record<string, readonly string[]> = {};
  for (const parentNodeId of parentNodeIds) {
    const parent = projectState.nodes[parentNodeId];
    if (parent?.children) {
      currentChildrenByParentId[parentNodeId] = parent.children;
    }
  }

  const nextChildrenByParentId = reconcileTmuxWindowNodePlacements({
    currentChildrenByParentId,
    nodeParentByNodeId,
    windowNodeIds,
    preferredWindowNodeOrder: windowNodeIds,
    transportNodeId: session.transportNodeId,
    missingWindowPlacement: options?.preserveExistingSidebarOrder ? "append" : "after-anchor",
  });

  const changedParentNodeIds = Object.entries(nextChildrenByParentId)
    .filter(([parentNodeId, nextChildren]) => {
      const currentChildren = projectState.nodes[parentNodeId]?.children ?? [];
      return nextChildren.length !== currentChildren.length
        || nextChildren.some((childId, index) => childId !== currentChildren[index]);
    })
    .map(([parentNodeId]) => parentNodeId);

  if (changedParentNodeIds.length === 0) {
    return;
  }

  useProjectStore.setState((state) => {
    const nodes = { ...state.nodes };
    for (const parentNodeId of changedParentNodeIds) {
      const parent = nodes[parentNodeId];
      if (!parent?.children) {
        continue;
      }
      nodes[parentNodeId] = {
        ...parent,
        children: nextChildrenByParentId[parentNodeId],
      };
    }
    return { nodes };
  });
}

function disposePaneTerminal(
  terminalId: string,
  details?: {
    sessionId?: string;
    windowId?: string;
    paneId?: string;
    reason?: string;
  }
) {
  debugLog("tmux.session", "dispose pane terminal", {
    terminalId,
    sessionId: details?.sessionId ?? null,
    windowId: details?.windowId ?? null,
    paneId: details?.paneId ?? null,
    reason: details?.reason ?? null,
  });
  disposeTerminalInstance(terminalId);
  useTerminalStore.getState().removeSession(terminalId);
  paneTerminalToSessionId.delete(terminalId);
}

function removeWindowProjection(session: TmuxControlSession, windowId: string) {
  const window = session.windows.get(windowId);
  if (!window) {
    return;
  }

  debugLog("tmux.session", "remove window projection", {
    sessionId: session.id,
    windowId,
    terminalId: window.terminalId,
    nodeId: window.nodeId,
  });

  const paneTerminalIds = [...session.panes.values()]
    .filter((pane) => pane.windowId === windowId)
    .map((pane) => pane.terminalId);
  const activeTerminalIdBeforeRemoval = useTerminalStore.getState().activeTerminalId;
  const shouldFocusAfterRemoval = Boolean(
    activeTerminalIdBeforeRemoval
    && (activeTerminalIdBeforeRemoval === window.terminalId || paneTerminalIds.includes(activeTerminalIdBeforeRemoval))
  );
  const windowOrderBeforeRemoval = [...session.windowOrder];
  const availableWindowIdsAfterRemoval = new Set(session.windows.keys());
  availableWindowIdsAfterRemoval.delete(windowId);
  const fallbackWindowId = shouldFocusAfterRemoval
    ? resolveAdjacentTmuxWindowAfterClose({
        windowOrder: windowOrderBeforeRemoval,
        closingWindowId: windowId,
        availableWindowIds: availableWindowIdsAfterRemoval,
      })
    : null;

  for (const pane of [...session.panes.values()]) {
    if (pane.windowId === windowId) {
      session.panes.delete(pane.paneId);
      disposePaneTerminal(pane.terminalId, {
        sessionId: session.id,
        windowId,
        paneId: pane.paneId,
        reason: "remove-window-projection",
      });
    }
  }

  removeWindowNodeFromAllParents(window.nodeId);
  useProjectStore.getState().removeNode(window.nodeId);
  useLayoutStore.getState().removeLayout(window.terminalId);
  useTerminalStore.getState().removeSession(window.terminalId);
  windowTerminalToSessionId.delete(window.terminalId);
  session.windows.delete(windowId);
  session.windowOrder = session.windowOrder.filter((id) => id !== windowId);
  session.pendingNewWindowActivations.delete(windowId);
  session.pendingWindowRedraws.delete(windowId);
  session.userPaneResizeLocks.delete(windowId);

  if (shouldFocusAfterRemoval) {
    const fallbackWindow = fallbackWindowId ? session.windows.get(fallbackWindowId) : null;
    const fallbackPaneTerminal = fallbackWindow?.activePaneId
      ? session.panes.get(fallbackWindow.activePaneId)?.terminalId
      : null;
    const fallbackTerminalId = fallbackPaneTerminal ?? fallbackWindow?.terminalId ?? session.transportTerminalId;
    if (fallbackWindow) {
      const placement = getWindowPlacement(session, fallbackWindow);
      useProjectStore.getState().setActiveProject(placement.projectId);
    }
    debugLog("tmux.focus", "focus adjacent window after close", {
      sessionId: session.id,
      closedWindowId: windowId,
      activeTerminalIdBeforeRemoval,
      fallbackWindowId,
      fallbackTerminalId,
      windowOrderBeforeRemoval,
      windowOrderAfterRemoval: session.windowOrder,
    });
    useTerminalStore.getState().setActiveTerminal(fallbackTerminalId);
    focusTerminalInstance(fallbackTerminalId);
  }
}

function rejectPendingCommands(session: TmuxControlSession, reason: string) {
  const error = new Error(`tmux control session ended: ${reason}`);
  const current = session.currentCommand;
  session.currentCommand = null;
  if (current?.pending) {
    current.pending.reject(error);
  }

  const pendingCommands = session.pendingCommands;
  session.pendingCommands = [];
  for (const pending of pendingCommands) {
    pending.reject(error);
  }
}

function detachControlSessionProjections(session: TmuxControlSession, reason: string) {
  debugLog("tmux.session", "detach projections", {
    sessionId: session.id,
    transportTerminalId: session.transportTerminalId,
    reason,
    windows: session.windows.size,
    panes: session.panes.size,
  });

  clearInitialPaneCaptureQueue(session);
  session.pendingWindowRedraws.clear();
  session.userPaneResizeLocks.clear();

  for (const pane of session.panes.values()) {
    paneTerminalToSessionId.delete(pane.terminalId);
    useTerminalStore.getState().patchSession(pane.terminalId, {
      backendKind: "tmux-pane",
      tmuxControlSessionId: undefined,
      tmuxWindowId: pane.windowId,
      tmuxPaneId: pane.paneId,
      cwd: pane.cwd,
    });
  }

  for (const window of session.windows.values()) {
    windowTerminalToSessionId.delete(window.terminalId);
    useTerminalStore.getState().patchSession(window.terminalId, {
      title: window.title,
      backendKind: "tmux-window",
      tmuxControlSessionId: undefined,
      tmuxWindowId: window.windowId,
      tmuxPaneId: undefined,
    });
    useProjectStore.getState().patchNode(window.nodeId, {
      name: window.title,
      hidden: false,
    });
  }

  session.windows.clear();
  session.panes.clear();
  session.windowOrder = [];
  session.pendingNewWindowAnchors = [];
  session.pendingNewWindowActivations.clear();
  session.pendingPaneOutput.clear();
}

function removeOrphanedTmuxWindowPlaceholders(session: TmuxControlSession, windowId: string) {
  const terminalState = useTerminalStore.getState();
  const projectState = useProjectStore.getState();
  const orphanTerminalIds: string[] = [];

  for (const [terminalId, terminalSession] of Object.entries(terminalState.sessions)) {
    if (
      terminalSession.tmuxControlSessionId
      || terminalSession.tmuxWindowId !== windowId
    ) {
      continue;
    }
    if (
      terminalSession.backendKind !== "tmux-window"
      && terminalSession.backendKind !== "tmux-pane"
    ) {
      continue;
    }
    orphanTerminalIds.push(terminalId);
  }

  if (orphanTerminalIds.length === 0) {
    return;
  }

  const orphanSet = new Set(orphanTerminalIds);
  const orphanNodeIds: string[] = [];

  for (const [nodeId, node] of Object.entries(projectState.nodes)) {
    if (node.type === "terminal" && node.terminalId && orphanSet.has(node.terminalId)) {
      orphanNodeIds.push(nodeId);
    }
  }

  debugLog("tmux.session", "remove orphaned window placeholders", {
    sessionId: session.id,
    windowId,
    orphanTerminalIds,
    orphanNodeIds,
  });

  for (const nodeId of orphanNodeIds) {
    for (const [parentId, parentNode] of Object.entries(useProjectStore.getState().nodes)) {
      if (parentNode.children?.includes(nodeId)) {
        removeWindowNodeFromParent(parentId, nodeId);
      }
    }
    useProjectStore.getState().removeNode(nodeId);
  }

  for (const terminalId of orphanTerminalIds) {
    useLayoutStore.getState().removeLayout(terminalId);
    disposeTerminalInstance(terminalId);
    useTerminalStore.getState().removeSession(terminalId);
    paneTerminalToSessionId.delete(terminalId);
  }
}

function upsertWindowProjection(
  session: TmuxControlSession,
  snapshot: TmuxWindowSnapshot,
  panes: readonly TmuxPaneSnapshot[],
  options?: {
    preserveLayout?: boolean;
    captureInitialContent?: boolean;
  }
): WindowProjectionResult | null {
  if (panes.length === 0) {
    debugLog("tmux.session", "skip window projection with no panes", {
      sessionId: session.id,
      windowId: snapshot.windowId,
      title: snapshot.title,
    });
    return null;
  }

  let windowState = session.windows.get(snapshot.windowId);
  const disconnectedWindowPlaceholder = !windowState
    ? findDisconnectedWindowPlaceholder(session, snapshot.windowId, snapshot.title)
    : null;
  if (!windowState) {
    if (!disconnectedWindowPlaceholder) {
      removeOrphanedTmuxWindowPlaceholders(session, snapshot.windowId);
    }
    const terminalId = disconnectedWindowPlaceholder?.terminalId ?? generateId();
    const nodeId = disconnectedWindowPlaceholder?.nodeId ?? generateId();
    windowState = {
      windowId: snapshot.windowId,
      terminalId,
      nodeId,
      title: snapshot.title,
      flags: snapshot.flags,
      activePaneId: null,
    };
    session.windows.set(snapshot.windowId, windowState);
    windowTerminalToSessionId.set(terminalId, session.id);

    if (disconnectedWindowPlaceholder) {
      session.transportMetadataAdopted = true;
      debugLog("tmux.session", "reuse disconnected window placeholder", {
        sessionId: session.id,
        windowId: snapshot.windowId,
        terminalId,
        nodeId,
      });
    } else {
      addSessionWithoutActivating({
        id: terminalId,
        title: snapshot.title,
        notes: "",
        cwd: undefined,
        hasDetectedActivity: false,
        lastUserInputAt: 0,
        lastOutputAt: 0,
        isNeedsAttention: false,
        isPossiblyDone: false,
        isLongInactive: false,
        isRecentlyFocused: false,
        backendKind: "tmux-window",
        tmuxControlSessionId: session.id,
        tmuxWindowId: snapshot.windowId,
      });

      addOrUpdateTreeNode(nodeId, {
        id: nodeId,
        type: "terminal",
        name: snapshot.title,
        terminalId,
        parentId: session.parentNodeId,
      });
    }
  }

  useTerminalStore.getState().patchSession(windowState.terminalId, {
    title: snapshot.title,
    backendKind: "tmux-window",
    tmuxControlSessionId: session.id,
    tmuxWindowId: snapshot.windowId,
  });

  useProjectStore.getState().patchNode(windowState.nodeId, {
    name: snapshot.title,
    hidden: false,
  });

  windowState.title = snapshot.title;
  windowState.flags = snapshot.flags;

  const previousLayoutTerminalIds = (() => {
    const currentLayout = useLayoutStore.getState().layouts[windowState.terminalId];
    return currentLayout ? findTerminalIds(currentLayout) : [];
  })();
  const disconnectedPanePlaceholders = getDisconnectedPanePlaceholders(
    windowState.terminalId,
    snapshot.windowId
  );
  const paneIds = new Set(panes.map((pane) => pane.paneId));
  for (const pane of [...session.panes.values()]) {
    if (pane.windowId === snapshot.windowId && !paneIds.has(pane.paneId)) {
      session.panes.delete(pane.paneId);
      disposePaneTerminal(pane.terminalId);
    }
  }

  const layoutPanes: TmuxPaneLayoutRecord[] = [];
  const changedPaneIds = new Set<string>();
  for (const paneSnapshot of panes) {
    let paneState = session.panes.get(paneSnapshot.paneId);
    const existingPaneState = paneState;
    if (!paneState) {
      const placeholderTerminalId = disconnectedPanePlaceholders.get(paneSnapshot.paneId);
      const terminalId = placeholderTerminalId ?? generateId();
      paneState = {
        paneId: paneSnapshot.paneId,
        windowId: paneSnapshot.windowId,
        terminalId,
        left: paneSnapshot.left,
        top: paneSnapshot.top,
        width: paneSnapshot.width,
        height: paneSnapshot.height,
        isActive: paneSnapshot.isActive,
        cwd: paneSnapshot.cwd,
        cursorX: paneSnapshot.cursorX,
        cursorY: paneSnapshot.cursorY,
        alternateOn: paneSnapshot.alternateOn,
        historySize: paneSnapshot.historySize,
        initialContentCaptured: false,
        lastHistoryCaptureSize: 0,
        lastHistoryRefreshAt: 0,
        lastHistoryRefreshDeferredLogAt: 0,
        historyCaptureInFlight: false,
        missedOutputSinceHistoryCapture: false,
        contentClearGeneration: 0,
      };
      session.panes.set(paneSnapshot.paneId, paneState);
      paneTerminalToSessionId.set(terminalId, session.id);

      if (placeholderTerminalId) {
        debugLog("tmux.session", "reuse disconnected pane placeholder", {
          sessionId: session.id,
          windowId: paneSnapshot.windowId,
          paneId: paneSnapshot.paneId,
          terminalId,
        });
      } else {
        addSessionWithoutActivating({
          id: terminalId,
          title: snapshot.title,
          notes: "",
          cwd: paneSnapshot.cwd,
          hasDetectedActivity: false,
          lastUserInputAt: 0,
          lastOutputAt: 0,
          isNeedsAttention: false,
          isPossiblyDone: false,
          isLongInactive: false,
          isRecentlyFocused: false,
          backendKind: "tmux-pane",
          tmuxControlSessionId: session.id,
          tmuxWindowId: paneSnapshot.windowId,
          tmuxPaneId: paneSnapshot.paneId,
        });
      }
      ensureTerminalFrontend(terminalId);

      const buffered = session.pendingPaneOutput.get(paneSnapshot.paneId);
      if (buffered) {
        session.pendingPaneOutput.delete(paneSnapshot.paneId);
        debugLog("tmux.session", "replay buffered pane output", {
          sessionId: session.id,
          paneId: paneSnapshot.paneId,
          terminalId,
          chunks: buffered.length,
        });
        for (const value of buffered) {
          queueTerminalOutput(terminalId, unescapeTmuxOutput(value));
        }
      }
    }
    ensurePaneHistoryCaptureState(paneState);

    if (
      existingPaneState
      && (
        existingPaneState.left !== paneSnapshot.left
        || existingPaneState.top !== paneSnapshot.top
        || existingPaneState.width !== paneSnapshot.width
        || existingPaneState.height !== paneSnapshot.height
      )
    ) {
      changedPaneIds.add(paneSnapshot.paneId);
    }

    syncTerminalFrontendSize(paneState.terminalId, paneSnapshot.width, paneSnapshot.height);

    const previousHistorySize = paneState.historySize;
    paneState.left = paneSnapshot.left;
    paneState.top = paneSnapshot.top;
    paneState.width = paneSnapshot.width;
    paneState.height = paneSnapshot.height;
    paneState.isActive = paneSnapshot.isActive;
    paneState.cwd = paneSnapshot.cwd;
    paneState.cursorX = paneSnapshot.cursorX;
    paneState.cursorY = paneSnapshot.cursorY;
    paneState.alternateOn = paneSnapshot.alternateOn;
    paneState.historySize = paneSnapshot.historySize;
    if (
      paneState.initialContentCaptured
      && paneState.historySize !== previousHistorySize
      && shouldCaptureAuthoritativePaneHistory(paneState)
    ) {
      debugLog("tmux.capture", "pane history coverage stale after snapshot", {
        sessionId: session.id,
        paneId: paneState.paneId,
        terminalId: paneState.terminalId,
        previousHistorySize,
        historySize: paneState.historySize,
        lastHistoryCaptureSize: paneState.lastHistoryCaptureSize,
        missedOutputSinceHistoryCapture: paneState.missedOutputSinceHistoryCapture,
      });
    }

    useTerminalStore.getState().patchSession(paneState.terminalId, {
      title: snapshot.title,
      cwd: paneSnapshot.cwd,
      backendKind: "tmux-pane",
      tmuxControlSessionId: session.id,
      tmuxWindowId: paneSnapshot.windowId,
      tmuxPaneId: paneSnapshot.paneId,
    });

    layoutPanes.push({
      paneId: paneSnapshot.paneId,
      terminalId: paneState.terminalId,
      left: paneSnapshot.left,
      top: paneSnapshot.top,
      width: paneSnapshot.width,
      height: paneSnapshot.height,
    });

    if (paneSnapshot.isActive) {
      windowState.activePaneId = paneSnapshot.paneId;
    }

    if (!paneState.initialContentCaptured && options?.captureInitialContent !== false) {
      queueInitialPaneContentCapture(session, paneState, {
        reason: "window-projection",
      });
    }
  }

  if (!windowState.activePaneId && panes.length > 0) {
    windowState.activePaneId = panes[0].paneId;
  }

  const nextPaneTerminalIds = new Set(layoutPanes.map((pane) => pane.terminalId));
  for (const terminalId of previousLayoutTerminalIds) {
    if (nextPaneTerminalIds.has(terminalId)) {
      continue;
    }

    const previousSession = getTerminalSession(terminalId);
    if (
      previousSession?.backendKind === "tmux-pane"
      && previousSession.tmuxWindowId === snapshot.windowId
    ) {
      debugLog("tmux.session", "remove stale pane from layout", {
        sessionId: session.id,
        windowId: snapshot.windowId,
        terminalId,
        paneId: previousSession.tmuxPaneId ?? null,
        title: snapshot.title,
      });
      paneTerminalToSessionId.delete(terminalId);
      disposeTerminalInstance(terminalId);
      useTerminalStore.getState().removeSession(terminalId);
    }
  }

  if (options?.preserveLayout) {
    debugLog("tmux.resize", "preserve user pane layout during tmux refresh", {
      sessionId: session.id,
      windowId: snapshot.windowId,
      terminalId: windowState.terminalId,
      panes: layoutPanes.length,
    });
    return { changedPaneIds: new Set() };
  }

  setLayout(windowState.terminalId, buildLayoutFromTmuxPanes(layoutPanes));
  return { changedPaneIds };
}

function setFocusedTmuxPane(
  session: TmuxControlSession,
  windowId: string,
  paneId: string,
  options?: {
    allowWindowSwitch?: boolean;
    requiredActiveWindowId?: string;
  }
): boolean {
  const window = session.windows.get(windowId);
  const pane = session.panes.get(paneId);
  if (!window || !pane) {
    return false;
  }

  window.activePaneId = paneId;
  const activeTerminalId = useTerminalStore.getState().activeTerminalId;
  const activeSession = activeTerminalId ? getTerminalSession(activeTerminalId) : null;
  const belongsToWindow =
    activeTerminalId === window.terminalId
    || (
      activeSession?.tmuxControlSessionId === session.id
      && activeSession.tmuxWindowId === windowId
    );
  const canAdoptFromTransport = activeTerminalId === session.transportTerminalId;
  const canSwitchFromActiveWindow =
    activeSession?.tmuxControlSessionId === session.id
    && (
      !options?.requiredActiveWindowId
      || activeSession.tmuxWindowId === options.requiredActiveWindowId
    );
  const canSwitchWindow =
    options?.allowWindowSwitch === true
    && (
      canAdoptFromTransport
      || canSwitchFromActiveWindow
    );
  if (!belongsToWindow && !canAdoptFromTransport && !canSwitchWindow) {
    debugLog("tmux.focus", "ignore sibling window notification", {
      sessionId: session.id,
      windowId,
      paneId,
      activeTerminalId,
      activeTmuxWindowId: activeSession?.tmuxWindowId ?? null,
      requiredActiveWindowId: options?.requiredActiveWindowId ?? null,
    });
    return false;
  }

  const placement = adoptSessionPlacementFromWindow(session, window);
  useProjectStore.getState().setActiveProject(placement.projectId);
  useTerminalStore.getState().setActiveTerminal(pane.terminalId);
  focusTerminalInstance(pane.terminalId);
  return true;
}

function isPaneVisibleInActiveWindow(session: TmuxControlSession, pane: TmuxPaneState): boolean {
  const activeTerminalId = useTerminalStore.getState().activeTerminalId;
  if (!activeTerminalId) {
    return false;
  }

  if (activeTerminalId === pane.terminalId) {
    return true;
  }

  const window = session.windows.get(pane.windowId);
  if (activeTerminalId === window?.terminalId) {
    return true;
  }

  const activeSession = getTerminalSession(activeTerminalId);
  return (
    activeSession?.tmuxControlSessionId === session.id
    && activeSession.tmuxWindowId === pane.windowId
  );
}

function markPaneOutputMissedByHistoryCapture(
  session: TmuxControlSession,
  pane: TmuxPaneState,
  bytes: number
) {
  ensurePaneHistoryCaptureState(pane);
  if (isPaneVisibleInActiveWindow(session, pane)) {
    return;
  }

  if (!pane.missedOutputSinceHistoryCapture) {
    debugLog("tmux.capture", "mark pane history stale from hidden output", {
      sessionId: session.id,
      paneId: pane.paneId,
      terminalId: pane.terminalId,
      historySize: pane.historySize,
      lastHistoryCaptureSize: pane.lastHistoryCaptureSize,
      bytes,
    });
  }
  pane.missedOutputSinceHistoryCapture = true;
}

type PaneHistoryStaleReason =
  | "hidden-output"
  | "initial-history-growth"
  | "history-shrank";

function getPaneHistoryStaleReason(pane: TmuxPaneState): PaneHistoryStaleReason | null {
  ensurePaneHistoryCaptureState(pane);
  if (!pane.initialContentCaptured || pane.historyCaptureInFlight || pane.alternateOn) {
    return null;
  }

  if (pane.lastHistoryCaptureSize === 0 && pane.historySize > 0) {
    return "initial-history-growth";
  }

  if (pane.historySize < pane.lastHistoryCaptureSize) {
    return "history-shrank";
  }

  if (pane.missedOutputSinceHistoryCapture) {
    return "hidden-output";
  }

  return null;
}

function shouldCaptureAuthoritativePaneHistory(pane: TmuxPaneState): boolean {
  return getPaneHistoryStaleReason(pane) !== null;
}

function canRefreshPaneHistoryForDisplay(
  pane: TmuxPaneState,
  displayReason: string,
  staleReason: PaneHistoryStaleReason,
  now: number
): boolean {
  if (displayReason !== "focus") {
    return false;
  }

  if (staleReason === "initial-history-growth" || pane.lastHistoryRefreshAt <= 0) {
    return true;
  }

  return now - pane.lastHistoryRefreshAt >= TMUX_HISTORY_REFRESH_COOLDOWN_MS;
}

function shouldUseFallbackHistoryCapture(
  pane: TmuxPaneState,
  staleReason: PaneHistoryStaleReason
): boolean {
  return (
    staleReason === "hidden-output"
    && pane.historySize <= 0
    && pane.lastHistoryCaptureSize <= 0
  );
}

function logDeferredPaneHistoryRefresh(
  session: TmuxControlSession,
  pane: TmuxPaneState,
  displayReason: string,
  staleReason: PaneHistoryStaleReason,
  now: number
) {
  ensurePaneHistoryCaptureState(pane);
  if (
    pane.lastHistoryRefreshDeferredLogAt > 0
    && now - pane.lastHistoryRefreshDeferredLogAt < TMUX_HISTORY_REFRESH_DEFER_LOG_INTERVAL_MS
  ) {
    return;
  }

  pane.lastHistoryRefreshDeferredLogAt = now;
  debugLog("tmux.capture", "defer pane history refresh", {
    sessionId: session.id,
    paneId: pane.paneId,
    terminalId: pane.terminalId,
    displayReason,
    staleReason,
    historySize: pane.historySize,
    lastHistoryCaptureSize: pane.lastHistoryCaptureSize,
    lastHistoryRefreshAt: pane.lastHistoryRefreshAt,
    cooldownMs: TMUX_HISTORY_REFRESH_COOLDOWN_MS,
    missedOutputSinceHistoryCapture: pane.missedOutputSinceHistoryCapture,
  });
}

async function sendCommand(session: TmuxControlSession, command: string): Promise<string[]> {
  debugLog("tmux.command", "queue", {
    sessionId: session.id,
    transportTerminalId: session.transportTerminalId,
    command,
    pendingCommands: session.pendingCommands.length + 1,
    activeCommand: session.currentCommand?.pending?.command ?? null,
  });

  return new Promise<string[]>((resolve, reject) => {
    const pending: PendingCommand = { command, resolve, reject };
    session.pendingCommands.push(pending);
    writeTerminal(session.transportTerminalId, `${command}\n`).catch((error) => {
      session.pendingCommands = session.pendingCommands.filter((entry) => entry !== pending);
      debugLog("tmux.command", "write failed", {
        sessionId: session.id,
        transportTerminalId: session.transportTerminalId,
        command,
        error: error instanceof Error ? error.message : String(error),
      });
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

function clearInitialPaneCaptureQueue(session: TmuxControlSession) {
  ensureInitialPaneCaptureState(session);
  if (session.initialPaneCaptureTimer !== null) {
    window.clearTimeout(session.initialPaneCaptureTimer);
    session.initialPaneCaptureTimer = null;
  }
  session.pendingInitialPaneCaptures = [];
}

function scheduleInitialPaneCaptureFlush(session: TmuxControlSession, delayMs: number) {
  ensureInitialPaneCaptureState(session);
  if (session.initialPaneCaptureTimer !== null) {
    if (delayMs > 0) {
      return;
    }
    window.clearTimeout(session.initialPaneCaptureTimer);
  }

  session.initialPaneCaptureTimer = window.setTimeout(() => {
    session.initialPaneCaptureTimer = null;
    flushInitialPaneCaptureQueue(session);
  }, delayMs);
}

function queueInitialPaneContentCapture(
  session: TmuxControlSession,
  pane: TmuxPaneState,
  options?: {
    priority?: boolean;
    reason?: string;
  }
) {
  ensureInitialPaneCaptureState(session);
  if (pane.initialContentCaptured) {
    session.pendingInitialPaneCaptures = session.pendingInitialPaneCaptures.filter(
      (paneId) => paneId !== pane.paneId
    );
    return;
  }

  const existingIndex = session.pendingInitialPaneCaptures.indexOf(pane.paneId);
  if (existingIndex !== -1) {
    session.pendingInitialPaneCaptures.splice(existingIndex, 1);
  }

  if (options?.priority) {
    session.pendingInitialPaneCaptures.unshift(pane.paneId);
  } else {
    session.pendingInitialPaneCaptures.push(pane.paneId);
  }

  debugLog("tmux.capture", "queue initial pane content", {
    sessionId: session.id,
    paneId: pane.paneId,
    terminalId: pane.terminalId,
    priority: Boolean(options?.priority),
    reason: options?.reason ?? null,
    queuedPanes: session.pendingInitialPaneCaptures.length,
  });

  scheduleInitialPaneCaptureFlush(
    session,
    options?.priority ? 0 : TMUX_INITIAL_CAPTURE_BACKGROUND_DELAY_MS
  );
}

function flushInitialPaneCaptureQueue(session: TmuxControlSession) {
  ensureInitialPaneCaptureState(session);
  if (!controlSessions.has(session.id)) {
    return;
  }
  if (session.initialPaneCaptureActive) {
    return;
  }
  if (session.currentCommand !== null || session.pendingCommands.length > 0) {
    scheduleInitialPaneCaptureFlush(session, TMUX_INITIAL_CAPTURE_RETRY_DELAY_MS);
    return;
  }

  let pane: TmuxPaneState | null = null;
  while (session.pendingInitialPaneCaptures.length > 0) {
    const paneId = session.pendingInitialPaneCaptures.shift()!;
    const candidate = session.panes.get(paneId) ?? null;
    if (candidate && !candidate.initialContentCaptured) {
      pane = candidate;
      break;
    }
  }
  if (!pane) {
    return;
  }

  session.initialPaneCaptureActive = true;
  debugLog("tmux.capture", "flush initial pane content", {
    sessionId: session.id,
    paneId: pane.paneId,
    terminalId: pane.terminalId,
    remainingQueuedPanes: session.pendingInitialPaneCaptures.length,
  });

  void captureInitialPaneContent(session, pane).finally(() => {
    session.initialPaneCaptureActive = false;
    if (!controlSessions.has(session.id)) {
      return;
    }
    if (session.pendingInitialPaneCaptures.length > 0) {
      scheduleInitialPaneCaptureFlush(session, TMUX_INITIAL_CAPTURE_BACKGROUND_DELAY_MS);
    }
  });
}

function queueHydratedInitialPaneCaptures(
  session: TmuxControlSession,
  windowSnapshots: readonly TmuxWindowSnapshot[],
  panesByWindowId: ReadonlyMap<string, readonly TmuxPaneSnapshot[]>,
  activeWindowId: string | null,
  activePaneId: string | null
) {
  const orderedPaneIds: string[] = [];
  const seenPaneIds = new Set<string>();
  const appendPaneId = (paneId: string | null | undefined) => {
    if (!paneId || seenPaneIds.has(paneId)) {
      return;
    }
    seenPaneIds.add(paneId);
    orderedPaneIds.push(paneId);
  };

  appendPaneId(activePaneId);
  for (const pane of activeWindowId ? panesByWindowId.get(activeWindowId) ?? [] : []) {
    appendPaneId(pane.paneId);
  }

  const snapshotWindowOrder = windowSnapshots.map((snapshot) => snapshot.windowId);
  const windowOrder = session.windowOrder.length > 0 ? session.windowOrder : snapshotWindowOrder;
  for (const windowId of windowOrder) {
    if (windowId === activeWindowId) {
      continue;
    }
    for (const pane of panesByWindowId.get(windowId) ?? []) {
      appendPaneId(pane.paneId);
    }
  }
  for (const windowId of snapshotWindowOrder) {
    for (const pane of panesByWindowId.get(windowId) ?? []) {
      appendPaneId(pane.paneId);
    }
  }

  let queuedCount = 0;
  orderedPaneIds.forEach((paneId, index) => {
    const pane = session.panes.get(paneId);
    if (!pane || pane.initialContentCaptured) {
      return;
    }
    queuedCount += 1;
    queueInitialPaneContentCapture(session, pane, {
      priority: index === 0,
      reason: index === 0 ? "hydrate-active-pane" : "hydrate-background-pane",
    });
  });

  debugLog("tmux.capture", "hydrated initial pane capture queue", {
    sessionId: session.id,
    activeWindowId,
    activePaneId,
    orderedPanes: orderedPaneIds.length,
    queuedPanes: queuedCount,
  });
}

async function capturePaneFullContent(
  session: TmuxControlSession,
  pane: TmuxPaneState,
  options: {
    initial?: boolean;
    reason: string;
    forceFallbackHistory?: boolean;
  }
) {
  ensurePaneHistoryCaptureState(pane);
  if (pane.historyCaptureInFlight) {
    return;
  }

  if (options.initial) {
    if (pane.initialContentCaptured) {
      return;
    }
    pane.initialContentCaptured = true;
  }

  pane.historyCaptureInFlight = true;
  const captureGeneration = pane.contentClearGeneration;
  const useFallbackHistory =
    options.forceFallbackHistory === true
    && !pane.alternateOn
    && pane.historySize <= pane.lastHistoryCaptureSize;
  const requestedHistorySize = useFallbackHistory ? undefined : pane.historySize;
  debugLog(
    "tmux.capture",
    options.initial ? "initial pane content start" : "pane history refresh start",
    {
      sessionId: session.id,
      paneId: pane.paneId,
      terminalId: pane.terminalId,
      reason: options.reason,
      alternateOn: pane.alternateOn,
      historySize: pane.historySize,
      requestedHistorySize: requestedHistorySize ?? null,
      lastHistoryCaptureSize: pane.lastHistoryCaptureSize,
      lastHistoryRefreshAt: pane.lastHistoryRefreshAt,
      missedOutputSinceHistoryCapture: pane.missedOutputSinceHistoryCapture,
      cursorX: pane.cursorX,
      cursorY: pane.cursorY,
    }
  );

  try {
    const lines = await sendCommand(
      session,
      buildTmuxPaneCaptureCommand({
        paneId: pane.paneId,
        alternateScreen: pane.alternateOn,
        historySize: requestedHistorySize,
      })
    );
    const currentPane = session.panes.get(pane.paneId);
    const terminal = getTerminalSession(pane.terminalId);
    if (currentPane?.terminalId !== pane.terminalId || !terminal) {
      debugLog("tmux.capture", "pane full content skipped for stale pane", {
        sessionId: session.id,
        paneId: pane.paneId,
        terminalId: pane.terminalId,
        reason: options.reason,
      });
      return;
    }
    ensurePaneHistoryCaptureState(currentPane);
    if (currentPane.contentClearGeneration !== captureGeneration) {
      debugLog("tmux.capture", "skip stale pane full content after clear", {
        sessionId: session.id,
        paneId: pane.paneId,
        terminalId: pane.terminalId,
        reason: options.reason,
        captureGeneration,
        currentGeneration: currentPane.contentClearGeneration,
      });
      return;
    }

    ensureTerminalFrontend(pane.terminalId);
    const cursorRow = Math.max(1, Math.floor(currentPane.cursorY) + 1);
    const cursorCol = Math.max(1, Math.floor(currentPane.cursorX) + 1);
    const content = unescapeTmuxOutput(lines.join("\r\n"));
    queueTerminalOutput(
      pane.terminalId,
      `\u001b[0m\u001b[?7l\u001b[H\u001b[2J\u001b[3J${content}\u001b[?7h\u001b[0m\u001b[${cursorRow};${cursorCol}H`,
      { recordActivity: false, allowParkedWrite: true }
    );
    currentPane.initialContentCaptured = true;
    currentPane.lastHistoryCaptureSize = currentPane.historySize;
    currentPane.lastHistoryRefreshDeferredLogAt = 0;
    if (!options.initial) {
      currentPane.lastHistoryRefreshAt = Date.now();
    }
    currentPane.missedOutputSinceHistoryCapture = false;
    debugLog(
      "tmux.capture",
      options.initial ? "initial pane content complete" : "pane history refresh complete",
      {
        sessionId: session.id,
        paneId: pane.paneId,
        terminalId: pane.terminalId,
        reason: options.reason,
        lines: lines.length,
        includesHistory: !pane.alternateOn && (useFallbackHistory || pane.historySize > 0),
        historySize: currentPane.historySize,
        lastHistoryCaptureSize: currentPane.lastHistoryCaptureSize,
        lastHistoryRefreshAt: currentPane.lastHistoryRefreshAt,
      }
    );
  } catch (error) {
    if (options.initial) {
      pane.initialContentCaptured = false;
    }
    debugLogError(
      "tmux.capture",
      options.initial ? "initial pane content failed" : "pane history refresh failed",
      error
    );
  } finally {
    const currentPane = session.panes.get(pane.paneId);
    if (currentPane?.terminalId === pane.terminalId) {
      ensurePaneHistoryCaptureState(currentPane);
      currentPane.historyCaptureInFlight = false;
    } else {
      pane.historyCaptureInFlight = false;
    }
  }
}

async function captureInitialPaneContent(session: TmuxControlSession, pane: TmuxPaneState) {
  await capturePaneFullContent(session, pane, {
    initial: true,
    reason: "initial",
  });
}

async function redrawVisiblePaneContent(
  session: TmuxControlSession,
  pane: TmuxPaneState,
  reason: string
) {
  ensurePaneHistoryCaptureState(pane);
  const captureGeneration = pane.contentClearGeneration;
  debugLog("tmux.capture", "visible pane redraw start", {
    sessionId: session.id,
    paneId: pane.paneId,
    terminalId: pane.terminalId,
    reason,
    alternateOn: pane.alternateOn,
    cursorX: pane.cursorX,
    cursorY: pane.cursorY,
  });

  const lines = await sendCommand(
    session,
    buildTmuxPaneCaptureCommand({
      paneId: pane.paneId,
      alternateScreen: pane.alternateOn,
      includeHistory: false,
    })
  );
  const currentPane = session.panes.get(pane.paneId);
  const terminal = getTerminalSession(pane.terminalId);
  if (currentPane?.terminalId !== pane.terminalId || !terminal) {
    debugLog("tmux.capture", "visible pane redraw skipped for stale pane", {
      sessionId: session.id,
      paneId: pane.paneId,
      terminalId: pane.terminalId,
      reason,
    });
    return;
  }
  ensurePaneHistoryCaptureState(currentPane);
  if (currentPane.contentClearGeneration !== captureGeneration) {
    debugLog("tmux.capture", "skip stale pane redraw after clear", {
      sessionId: session.id,
      paneId: pane.paneId,
      terminalId: pane.terminalId,
      reason,
      captureGeneration,
      currentGeneration: currentPane.contentClearGeneration,
    });
    return;
  }

  ensureTerminalFrontend(pane.terminalId);
  const cursorRow = Math.max(1, Math.floor(currentPane.cursorY) + 1);
  const cursorCol = Math.max(1, Math.floor(currentPane.cursorX) + 1);
  const content = unescapeTmuxOutput(lines.join("\r\n"));
  queueTerminalOutput(
    pane.terminalId,
    `\u001b[0m\u001b[?7l\u001b[H\u001b[2J${content}\u001b[?7h\u001b[0m\u001b[${cursorRow};${cursorCol}H`,
    { recordActivity: false }
  );
  debugLog("tmux.capture", "visible pane redraw complete", {
    sessionId: session.id,
    paneId: pane.paneId,
    terminalId: pane.terminalId,
    reason,
    lines: lines.length,
  });
}

async function refreshPaneContentForDisplay(
  session: TmuxControlSession,
  pane: TmuxPaneState,
  reason: string
) {
  ensurePaneHistoryCaptureState(pane);
  if (pane.historyCaptureInFlight) {
    debugLog("tmux.capture", "skip pane display refresh during history capture", {
      sessionId: session.id,
      paneId: pane.paneId,
      terminalId: pane.terminalId,
      reason,
    });
    return;
  }

  const staleReason = getPaneHistoryStaleReason(pane);
  if (staleReason) {
    const now = Date.now();
    if (!canRefreshPaneHistoryForDisplay(pane, reason, staleReason, now)) {
      logDeferredPaneHistoryRefresh(session, pane, reason, staleReason, now);
      await redrawVisiblePaneContent(session, pane, reason);
      return;
    }

    await capturePaneFullContent(session, pane, {
      reason,
      forceFallbackHistory: shouldUseFallbackHistoryCapture(pane, staleReason),
    });
    return;
  }

  await redrawVisiblePaneContent(session, pane, reason);
}

async function refreshSingleWindow(session: TmuxControlSession, windowId: string) {
  debugLog("tmux.refresh", "refresh window start", {
    sessionId: session.id,
    windowId,
  });

  const [windowLines, paneLines] = await Promise.all([
    sendCommand(session, buildTmuxWindowSnapshotCommand(windowId)),
    sendCommand(session, buildTmuxPaneSnapshotCommand({ targetWindowId: windowId })),
  ]);

  const windowSnapshots = windowLines
    .map(parseTmuxWindowSnapshot)
    .filter((value): value is TmuxWindowSnapshot => Boolean(value));
  const snapshot = windowSnapshots.find((value) => value.windowId === windowId) ?? null;
  if (!snapshot) {
    debugLog("tmux.refresh", "refresh window missing snapshot", {
      sessionId: session.id,
      windowId,
      windowLineCount: windowLines.length,
      paneLineCount: paneLines.length,
      windowLines: windowLines.map((line) => previewDebugText(line, 120)),
    });
    if (windowLines.length > 0) {
      return;
    }
    removeWindowProjection(session, windowId);
    syncWindowNodeOrder(session);
    return;
  }

  const paneSnapshots = paneLines
    .map(parseTmuxPaneSnapshot)
    .filter((value): value is TmuxPaneSnapshot => Boolean(value));
  if (paneSnapshots.length === 0) {
    debugLog("tmux.refresh", "refresh window missing panes", {
      sessionId: session.id,
      windowId,
      title: snapshot.title,
      windowLineCount: windowLines.length,
      paneLineCount: paneLines.length,
      paneLines: paneLines.map((line) => previewDebugText(line, 120)),
    });
    return;
  }

  const preserveUserPaneLayout = isTmuxWindowUserPaneResizeLocked(session, snapshot.windowId);
  const projection = upsertWindowProjection(session, snapshot, paneSnapshots, {
    preserveLayout: preserveUserPaneLayout,
  });
  syncWindowNodeOrder(session);

  const shouldRedrawWindow = session.pendingWindowRedraws.delete(snapshot.windowId);
  const paneStates = paneSnapshots
    .map((paneSnapshot) => session.panes.get(paneSnapshot.paneId))
    .filter((pane): pane is TmuxPaneState => Boolean(pane));
  const paneStatesToRedraw = shouldRedrawWindow
    ? paneStates
    : paneStates.filter((pane) => projection?.changedPaneIds.has(pane.paneId));

  if (paneStatesToRedraw.length > 0) {
    const reason = shouldRedrawWindow ? "resize" : "layout-change";
    void Promise.all(
      paneStatesToRedraw.map((pane) => refreshPaneContentForDisplay(session, pane, reason))
    ).catch((error) => {
      debugLogError("tmux.capture", `${reason} pane redraw failed`, error);
    });
  }

  const pendingActivationAnchorWindowId = session.pendingNewWindowActivations.get(snapshot.windowId) ?? null;
  const shouldActivateNewWindow = pendingActivationAnchorWindowId !== null;
  if (snapshot.isActive || shouldActivateNewWindow) {
    const activePaneId = paneSnapshots.find((pane) => pane.isActive)?.paneId
      ?? session.windows.get(snapshot.windowId)?.activePaneId
      ?? null;
    if (activePaneId) {
      debugLog("tmux.focus", "refresh active window", {
        sessionId: session.id,
        windowId: snapshot.windowId,
        paneId: activePaneId,
        userCreatedWindow: shouldActivateNewWindow,
      });
      setFocusedTmuxPane(
        session,
        snapshot.windowId,
        activePaneId,
        shouldActivateNewWindow
          ? {
            allowWindowSwitch: true,
            requiredActiveWindowId: pendingActivationAnchorWindowId ?? undefined,
          }
          : undefined
      );
      if (shouldActivateNewWindow) {
        session.pendingNewWindowActivations.delete(snapshot.windowId);
      }
    }
  }

  debugLog("tmux.refresh", "refresh window complete", {
    sessionId: session.id,
    windowId,
    title: snapshot.title,
    panes: paneSnapshots.length,
  });
}

async function hydrateControlSession(session: TmuxControlSession) {
  if (session.hydrationPromise) {
    debugLog("tmux.session", "hydrate reused", {
      sessionId: session.id,
      transportTerminalId: session.transportTerminalId,
    });
    return session.hydrationPromise;
  }

  session.hydrationPromise = (async () => {
    debugLog("tmux.session", "hydrate start", {
      sessionId: session.id,
      transportTerminalId: session.transportTerminalId,
      existingWindows: session.windows.size,
      existingPanes: session.panes.size,
    });

    const [windowLines, paneLines] = await Promise.all([
      sendCommand(session, buildTmuxWindowSnapshotCommand()),
      // Attach flows can restore a session with multiple windows; tmux defaults
      // list-panes to the current window only, so hydrate must enumerate all panes.
      sendCommand(session, buildTmuxPaneSnapshotCommand({ allWindows: true })),
    ]);

    const windowSnapshots = windowLines
      .map(parseTmuxWindowSnapshot)
      .filter((value): value is TmuxWindowSnapshot => Boolean(value));
    const paneSnapshots = paneLines
      .map(parseTmuxPaneSnapshot)
      .filter((value): value is TmuxPaneSnapshot => Boolean(value));

    if (windowSnapshots.length === 0 || paneSnapshots.length === 0) {
      debugLog("tmux.session", "hydrate skipped unsafe snapshot", {
        sessionId: session.id,
        transportTerminalId: session.transportTerminalId,
        windowLineCount: windowLines.length,
        paneLineCount: paneLines.length,
        parsedWindows: windowSnapshots.length,
        parsedPanes: paneSnapshots.length,
        windowLines: windowLines.slice(0, 5).map((line) => previewDebugText(line, 120)),
        paneLines: paneLines.slice(0, 5).map((line) => previewDebugText(line, 120)),
      });
      return;
    }

    const panesByWindowId = new Map<string, TmuxPaneSnapshot[]>();
    for (const pane of paneSnapshots) {
      const group = panesByWindowId.get(pane.windowId);
      if (group) {
        group.push(pane);
      } else {
        panesByWindowId.set(pane.windowId, [pane]);
      }
    }

    const preserveExistingSidebarOrder =
      session.windows.size > 0
      || windowSnapshots.some((snapshot) => hasDisconnectedWindowPlaceholder(snapshot.windowId));

    const nextWindowIds = new Set(windowSnapshots.map((snapshot) => snapshot.windowId));
    for (const existingWindowId of [...session.windows.keys()]) {
      if (!nextWindowIds.has(existingWindowId)) {
        removeWindowProjection(session, existingWindowId);
      }
    }

    for (const snapshot of windowSnapshots) {
      upsertWindowProjection(session, snapshot, panesByWindowId.get(snapshot.windowId) ?? [], {
        captureInitialContent: false,
      });
    }

    const parentChildren = useProjectStore.getState().nodes[session.parentNodeId]?.children ?? [];
    session.windowOrder = buildPreferredTmuxWindowOrder({
      currentChildren: parentChildren,
      windows: [...session.windows.values()].map((window) => ({
        windowId: window.windowId,
        nodeId: window.nodeId,
      })),
      snapshotWindowOrder: windowSnapshots.map((snapshot) => snapshot.windowId),
    });

    syncWindowNodeOrder(session, { preserveExistingSidebarOrder });

    const activeWindow = windowSnapshots.find((snapshot) => snapshot.isActive) ?? windowSnapshots[0];
    const activePane = activeWindow
      ? (panesByWindowId.get(activeWindow.windowId) ?? []).find((pane) => pane.isActive)
        ?? (panesByWindowId.get(activeWindow.windowId) ?? [])[0]
      : null;
    if (activeWindow && activePane) {
      setFocusedTmuxPane(session, activeWindow.windowId, activePane.paneId, {
        allowWindowSwitch: true,
      });
    }
    queueHydratedInitialPaneCaptures(
      session,
      windowSnapshots,
      panesByWindowId,
      activeWindow?.windowId ?? null,
      activePane?.paneId ?? null
    );
    if (activeWindow && !session.transportMetadataAdopted) {
      adoptTransportMetadataForWindow(session, activeWindow.windowId);
    }

    debugLog("tmux.session", "hydrate complete", {
      sessionId: session.id,
      windows: windowSnapshots.length,
      panes: paneSnapshots.length,
      activeWindowId: activeWindow?.windowId ?? null,
      activePaneId: activePane?.paneId ?? null,
    });
  })().catch((error) => {
    debugLogError("tmux.session", "hydrate failed", error);
    throw error;
  }).finally(() => {
    session.hydrationPromise = null;
  });

  return session.hydrationPromise;
}

function adoptTransportMetadataForWindow(session: TmuxControlSession, windowId: string) {
  if (session.transportMetadataAdopted) {
    return;
  }

  const window = session.windows.get(windowId);
  if (!window) {
    return;
  }

  session.transportMetadataAdopted = true;

  if (session.transportNotes) {
    useTerminalStore.getState().patchSession(window.terminalId, {
      notes: session.transportNotes,
    });
  }

  const inheritedTitle = session.transportTitle.trim();
  if (!inheritedTitle || isGenericDispatcherTitle(inheritedTitle)) {
    return;
  }

  window.title = inheritedTitle;
  useTerminalStore.getState().patchSession(window.terminalId, {
    title: inheritedTitle,
  });
  useProjectStore.getState().patchNode(window.nodeId, {
    name: inheritedTitle,
  });

  debugLog("tmux.session", "adopt transport metadata", {
    sessionId: session.id,
    windowId,
    title: inheritedTitle,
    notesLength: session.transportNotes.length,
  });

  void sendCommand(
    session,
    `rename-window -t ${window.windowId} ${quoteTmuxCommandArgument(inheritedTitle)}`
  ).catch((error) => {
    debugLogError("tmux.session", "rename inherited title failed", error);
  });
}

function scheduleRefresh(session: TmuxControlSession, windowId?: string) {
  debugLog("tmux.refresh", "schedule", {
    sessionId: session.id,
    windowId: windowId ?? null,
    fullRefresh: !windowId,
    alreadyScheduled: session.refreshTimer !== null,
  });

  if (windowId) {
    session.pendingWindowRefreshes.add(windowId);
  } else {
    session.fullRefreshPending = true;
  }

  if (session.refreshTimer !== null) {
    return;
  }

  session.refreshTimer = window.setTimeout(() => {
    session.refreshTimer = null;
    const fullRefresh = session.fullRefreshPending;
    const windowIds = [...session.pendingWindowRefreshes];
    session.fullRefreshPending = false;
    session.pendingWindowRefreshes.clear();

    debugLog("tmux.refresh", "flush", {
      sessionId: session.id,
      fullRefresh,
      windowIds,
    });

    if (fullRefresh) {
      void hydrateControlSession(session).catch((error) => {
        debugLogError("tmux.refresh", "full refresh failed", error);
      });
      return;
    }

    for (const pendingWindowId of windowIds) {
      void refreshSingleWindow(session, pendingWindowId).catch((error) => {
        debugLog("tmux.refresh", "window refresh failed", {
          sessionId: session.id,
          windowId: pendingWindowId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }, 0);
}

function flushBootstrapRefresh(session: TmuxControlSession) {
  if (!session.needsBootstrapRefresh) {
    return;
  }

  if (session.bootstrapRefreshTimer !== null) {
    window.clearTimeout(session.bootstrapRefreshTimer);
    session.bootstrapRefreshTimer = null;
  }
  session.needsBootstrapRefresh = false;
  debugLog("tmux.session", "bootstrap refresh scheduled", {
    sessionId: session.id,
    transportTerminalId: session.transportTerminalId,
  });
  scheduleRefresh(session);
}

function scheduleBootstrapRefresh(session: TmuxControlSession) {
  if (session.bootstrapRefreshTimer !== null) {
    return;
  }

  session.bootstrapRefreshTimer = window.setTimeout(() => {
    session.bootstrapRefreshTimer = null;
    if (!controlSessions.has(session.id)) {
      return;
    }
    if (
      session.currentCommand !== null
      || session.pendingCommands.length > 0
    ) {
      scheduleBootstrapRefresh(session);
      return;
    }
    flushBootstrapRefresh(session);
  }, TMUX_BOOTSTRAP_FALLBACK_DELAY_MS);
}

function teardownControlSession(session: TmuxControlSession, reason: string) {
  debugLog("tmux.session", "teardown start", {
    sessionId: session.id,
    transportTerminalId: session.transportTerminalId,
    reason,
    windows: session.windows.size,
    panes: session.panes.size,
  });

  if (session.refreshTimer !== null) {
    window.clearTimeout(session.refreshTimer);
    session.refreshTimer = null;
  }
  if (session.bootstrapRefreshTimer !== null) {
    window.clearTimeout(session.bootstrapRefreshTimer);
    session.bootstrapRefreshTimer = null;
  }

  const activeTerminalId = useTerminalStore.getState().activeTerminalId;
  const activeSession = activeTerminalId ? getTerminalSession(activeTerminalId) : null;
  const activeBelongsToSession =
    activeTerminalId === session.transportTerminalId
    || activeSession?.tmuxControlSessionId === session.id;

  rejectPendingCommands(session, reason);
  detachControlSessionProjections(session, reason);

  useProjectStore.getState().patchNode(session.transportNodeId, { hidden: false });
  useTerminalStore.getState().patchSession(session.transportTerminalId, {
    backendKind: "local",
    tmuxControlSessionId: undefined,
    tmuxWindowId: undefined,
    tmuxPaneId: undefined,
  });

  if (activeBelongsToSession) {
    useProjectStore.getState().setActiveProject(session.projectId);
    useTerminalStore.getState().setActiveTerminal(session.transportTerminalId);
    focusTerminalInstance(session.transportTerminalId);
  }

  controlSessions.delete(session.id);
  transportTerminalToSessionId.delete(session.transportTerminalId);
  transportRawCarry.delete(session.transportTerminalId);
  debugLog("tmux.session", "teardown complete", {
    sessionId: session.id,
    transportTerminalId: session.transportTerminalId,
    reason,
  });
}

function parseOutputNotification(line: string): { paneId: string; value: string } | null {
  const match = /^%output\s+(\S+)\s?(.*)$/.exec(line);
  if (!match) {
    return null;
  }
  return {
    paneId: match[1],
    value: match[2] ?? "",
  };
}

function handleNotification(session: TmuxControlSession, line: string) {
  if (line.startsWith("%output ")) {
    const parsed = parseOutputNotification(line);
    if (!parsed) {
      debugLog("tmux.notify", "output parse failed", {
        sessionId: session.id,
        line: previewDebugText(line, 200),
      });
      return;
    }
    const pane = session.panes.get(parsed.paneId);
    if (!pane) {
      const pending = pushPendingPaneOutput(session, parsed.paneId, parsed.value);
      debugLog("tmux.notify", "buffer output for pending pane", {
        sessionId: session.id,
        paneId: parsed.paneId,
        bufferedChunks: pending.chunks,
        bufferedChars: pending.totalChars,
        droppedChunks: pending.droppedChunks,
        preview: previewDebugText(parsed.value, 120),
      });
      return;
    }

    const recordActivity = shouldRecordPaneOutputActivity(session, parsed.paneId);
    if (session.outputLogCount < TMUX_OUTPUT_LOG_LIMIT) {
      session.outputLogCount += 1;
      debugLog("tmux.notify", "output", {
        sessionId: session.id,
        paneId: parsed.paneId,
        bytes: parsed.value.length,
        recordActivity,
        preview: previewDebugText(parsed.value, 120),
      });
    } else if (!session.outputLogSuppressed) {
      session.outputLogSuppressed = true;
      debugLog("tmux.notify", "output logging suppressed", {
        sessionId: session.id,
        limit: TMUX_OUTPUT_LOG_LIMIT,
      });
    }

    const output = unescapeTmuxOutput(parsed.value);
    markPaneOutputMissedByHistoryCapture(session, pane, parsed.value.length);
    if (recordActivity) {
      queueTerminalOutput(pane.terminalId, output);
    } else {
      recordSuppressedPaneOutputActivity(session, pane, parsed.value);
      queueTerminalOutput(pane.terminalId, output, { recordActivity: false });
    }
    return;
  }

  debugLog("tmux.notify", "event", {
    sessionId: session.id,
    line: previewDebugText(line, 200),
  });

  if (line.startsWith("%window-add ")) {
    const windowId = line.slice("%window-add ".length).trim();
    if (windowId) {
      const anchor = session.pendingNewWindowAnchors.shift() ?? null;
      session.windowOrder = insertWindowIdAfterAnchor(
        session.windowOrder,
        windowId,
        anchor?.anchorWindowId ?? null
      );
      if (anchor) {
        session.pendingNewWindowActivations.set(windowId, anchor.anchorWindowId);
      }
      scheduleRefresh(session, windowId);
    }
    return;
  }

  if (line.startsWith("%window-close ") || line.startsWith("%unlinked-window-close ")) {
    const prefix = line.startsWith("%window-close ")
      ? "%window-close "
      : "%unlinked-window-close ";
    const windowId = line.slice(prefix.length).trim();
    if (windowId) {
      removeWindowProjection(session, windowId);
      syncWindowNodeOrder(session);
    }
    return;
  }

  if (line.startsWith("%window-renamed ")) {
    const [, windowId = "", title = ""] = /^%window-renamed\s+(\S+)\s?(.*)$/.exec(line) ?? [];
    const window = session.windows.get(windowId);
    if (!window) {
      return;
    }
    window.title = title;
    useTerminalStore.getState().patchSession(window.terminalId, { title });
    useProjectStore.getState().patchNode(window.nodeId, { name: title });
    return;
  }

  if (line.startsWith("%layout-change ")) {
    const parts = line.split(" ");
    const windowId = parts[1];
    if (windowId) {
      if (shouldSuppressTmuxLayoutChange(session, windowId)) {
        return;
      }
      scheduleRefresh(session, windowId);
    }
    return;
  }

  if (line.startsWith("%window-pane-changed ")) {
    const [, windowId = "", paneId = ""] = /^%window-pane-changed\s+(\S+)\s+(\S+)$/.exec(line) ?? [];
    if (windowId && paneId) {
      const window = session.windows.get(windowId);
      if (window) {
        window.activePaneId = paneId;
      }
      setFocusedTmuxPane(session, windowId, paneId);
    }
    return;
  }

  if (line.startsWith("%session-window-changed ")) {
    const [, , windowId = ""] = /^%session-window-changed\s+(\S+)\s+(\S+)$/.exec(line) ?? [];
    if (windowId) {
      scheduleRefresh(session, windowId);
      const window = session.windows.get(windowId);
      if (window?.activePaneId) {
        setFocusedTmuxPane(session, windowId, window.activePaneId);
      }
    }
    return;
  }

  if (line.startsWith("%sessions-changed") || line.startsWith("%session-changed ")) {
    scheduleRefresh(session);
    return;
  }

  if (line.startsWith("%exit")) {
    teardownControlSession(session, "tmux-%exit");
  }
}

function processControlLine(session: TmuxControlSession, line: string) {
  if (session.currentCommand) {
    if (line.startsWith("%end ")) {
      const current = session.currentCommand;
      session.currentCommand = null;
      debugLog("tmux.command", "complete", {
        sessionId: session.id,
        command: current.pending?.command ?? null,
        responseLines: current.lines.length,
      });
      current.pending?.resolve(current.lines);
      return;
    }
    if (line.startsWith("%error ")) {
      const current = session.currentCommand;
      session.currentCommand = null;
      const failedCommand = current.pending?.command ?? "<none>";
      debugLog("tmux.command", "error", {
        sessionId: session.id,
        command: failedCommand,
        responseLines: current.lines.length,
        responsePreview: previewDebugText(current.lines.join("\n"), 200),
      });
      current.pending?.reject(new Error(current.lines.join("\n") || `tmux command failed: ${failedCommand}`));
      return;
    }
    session.currentCommand.lines.push(line);
    return;
  }

  if (line.startsWith("%begin ")) {
    const pending = session.pendingCommands.shift() ?? null;
    debugLog("tmux.command", "begin", {
      sessionId: session.id,
      command: pending?.command ?? null,
      remainingQueue: session.pendingCommands.length,
      line: previewDebugText(line, 120),
    });
    session.currentCommand = {
      pending,
      lines: [],
    };
    return;
  }

  if (line.length === 0) {
    return;
  }

  if (!line.startsWith("%")) {
    debugLog("tmux.protocol", "unscoped line", {
      sessionId: session.id,
      line: previewDebugText(line, 200),
    });
  }

  handleNotification(session, line);
}

function processControlChunk(session: TmuxControlSession, chunk: string) {
  session.lineBuffer += chunk;

  while (true) {
    const newlineIndex = session.lineBuffer.indexOf("\n");
    if (newlineIndex === -1) {
      break;
    }

    let line = session.lineBuffer.slice(0, newlineIndex);
    session.lineBuffer = session.lineBuffer.slice(newlineIndex + 1);
    if (line.endsWith("\r")) {
      line = line.slice(0, -1);
    }
    processControlLine(session, line);
  }

  if (
    session.needsBootstrapRefresh
    && session.lineBuffer.length === 0
    && session.currentCommand === null
    && session.pendingCommands.length === 0
  ) {
    flushBootstrapRefresh(session);
  }
}

function createControlSession(transportTerminalId: string): TmuxControlSession | null {
  const existing = transportTerminalToSessionId.get(transportTerminalId);
  if (existing) {
    debugLog("tmux.session", "reuse existing session", {
      transportTerminalId,
      sessionId: existing,
    });
    return controlSessions.get(existing) ?? null;
  }

  const projectState = useProjectStore.getState();
  const terminalState = useTerminalStore.getState();
  const layouts = useLayoutStore.getState().layouts;
  const tabRootTerminalId = findLayoutKeyForTerminal(layouts, transportTerminalId) ?? transportTerminalId;
  const transportSession = terminalState.sessions[tabRootTerminalId] ?? terminalState.sessions[transportTerminalId];
  const transportNodeEntry = findNodeByTerminalId(projectState.nodes, tabRootTerminalId);
  const projectId = findProjectIdForTerminal(
    projectState.projects,
    projectState.projectOrder,
    projectState.nodes,
    terminalState.sessions,
    tabRootTerminalId
  );

  if (!transportNodeEntry || !projectId || !transportNodeEntry.node.parentId) {
    debugLog("tmux.session", "create failed", {
      transportTerminalId,
      tabRootTerminalId,
      hasTransportNode: Boolean(transportNodeEntry),
      projectId: projectId ?? null,
      parentNodeId: transportNodeEntry?.node.parentId ?? null,
    });
    return null;
  }

  const session: TmuxControlSession = {
    id: transportTerminalId,
    transportTerminalId,
    projectId,
    transportProjectId: projectId,
    transportNodeId: transportNodeEntry.nodeId,
    parentNodeId: transportNodeEntry.node.parentId,
    transportParentNodeId: transportNodeEntry.node.parentId,
    transportTitle: transportSession?.title ?? "",
    transportNotes: transportSession?.notes ?? "",
    transportMetadataAdopted: false,
    controlModeActive: true,
    lineBuffer: "",
    pendingCommands: [],
    currentCommand: null,
    windows: new Map(),
    panes: new Map(),
    windowOrder: [],
    refreshTimer: null,
    pendingWindowRefreshes: new Set(),
    fullRefreshPending: false,
    hydrationPromise: null,
    bootstrapRefreshTimer: null,
    pendingNewWindowAnchors: [],
    pendingNewWindowActivations: new Map(),
    windowSizes: new Map(),
    clientSize: null,
    clientResizeLayoutSuppressionWindowId: null,
    clientResizeLayoutSuppressionUntil: 0,
    clientResizeLayoutSuppressedCount: 0,
    pendingWindowRedraws: new Set(),
    userPaneResizeLocks: new Map(),
    outputLogCount: 0,
    outputLogSuppressed: false,
    transportLogCount: 0,
    transportLogSuppressed: false,
    transportSummaryChunks: 0,
    transportSummaryBytes: 0,
    transportSummaryPassthroughBytes: 0,
    transportSummaryLastLoggedAt: 0,
    needsBootstrapRefresh: true,
    pendingPaneOutput: new Map(),
    pendingInitialPaneCaptures: [],
    initialPaneCaptureTimer: null,
    initialPaneCaptureActive: false,
    paneOutputActivitySuppressionUntil: new Map(),
    suppressedPaneOutputActivitySummaries: new Map(),
  };

  controlSessions.set(session.id, session);
  transportTerminalToSessionId.set(transportTerminalId, session.id);
  useTerminalStore.getState().patchSession(transportTerminalId, {
    backendKind: "tmux-transport",
    tmuxControlSessionId: session.id,
  });
  useProjectStore.getState().patchNode(transportNodeEntry.nodeId, { hidden: true });
  debugLog("tmux.session", "create", {
    sessionId: session.id,
    transportTerminalId,
    tabRootTerminalId,
    projectId,
    transportNodeId: transportNodeEntry.nodeId,
    parentNodeId: transportNodeEntry.node.parentId,
  });
  return session;
}

export function routeTmuxTransportOutput(terminalId: string, data: string): string {
  const existingSession = getControlSessionById(transportTerminalToSessionId.get(terminalId) ?? terminalId);
  const existingSessionId = existingSession?.id ?? null;
  let session = existingSession;
  const priorCarry = transportRawCarry.get(terminalId) ?? "";
  let remaining = priorCarry + data;
  let passthrough = "";
  transportRawCarry.set(terminalId, "");
  const hasBareControlOutput = findTmuxControlLineStart(data) !== -1;
  const shouldLogTransportChunk = Boolean(
    existingSessionId
    || priorCarry.length > 0
    || data.includes(TMUX_CONTROL_START)
    || data.includes(TMUX_CONTROL_END)
    || hasBareControlOutput
  );

  if (shouldLogTransportChunk) {
    if (existingSession) {
      debugTmuxTransportChunk(existingSession, terminalId, data, priorCarry.length, existingSessionId);
    } else {
      debugLog("tmux.transport", "chunk", {
        terminalId,
        existingSessionId: existingSessionId ?? null,
        carryLength: priorCarry.length,
        bytes: data.length,
        preview: previewDebugText(data, 200),
      });
    }
  }

  while (remaining.length > 0) {
    if (!session) {
      const dcsStartIndex = remaining.indexOf(TMUX_CONTROL_START);
      const bareStartIndex = findTmuxControlLineStart(remaining);
      const hasDcsStart = dcsStartIndex !== -1;
      const hasBareStart = bareStartIndex !== -1;
      if (!hasDcsStart && !hasBareStart) {
        const carry = getTransportControlStartCarry(remaining);
        passthrough += remaining.slice(0, remaining.length - carry.length);
        transportRawCarry.set(terminalId, carry);
        if (shouldLogTransportChunk && carry.length > 0) {
          debugLog("tmux.transport", "waiting for start marker continuation", {
            terminalId,
            carryLength: carry.length,
            carryPreview: previewDebugText(carry, 40),
          });
        }
        break;
      }

      const useBareStart = hasBareStart && (!hasDcsStart || bareStartIndex < dcsStartIndex);
      const startIndex = useBareStart ? bareStartIndex : dcsStartIndex;
      debugLog("tmux.transport", useBareStart ? "bare control stream detected" : "start marker detected", {
        terminalId,
        startIndex,
      });
      passthrough += remaining.slice(0, startIndex);
      remaining = useBareStart
        ? remaining.slice(startIndex)
        : remaining.slice(startIndex + TMUX_CONTROL_START.length);
      session = createControlSession(terminalId);
      if (!session) {
        debugLog("tmux.transport", "control stream fallback to passthrough", {
          terminalId,
          bareControl: useBareStart,
        });
        if (useBareStart) {
          passthrough += remaining;
          remaining = "";
          break;
        }
        passthrough += TMUX_CONTROL_START;
        continue;
      }
      scheduleBootstrapRefresh(session);
      continue;
    }

    const endIndex = remaining.indexOf(TMUX_CONTROL_END);
    if (endIndex === -1) {
      const carry = getMarkerCarry(remaining, TMUX_CONTROL_END);
      processControlChunk(session, remaining.slice(0, remaining.length - carry.length));
      transportRawCarry.set(terminalId, carry);
      if (carry.length > 0) {
        debugLog("tmux.transport", "waiting for end marker continuation", {
          terminalId,
          sessionId: session.id,
          carryLength: carry.length,
          carryPreview: previewDebugText(carry, 40),
        });
      }
      break;
    }

    processControlChunk(session, remaining.slice(0, endIndex));
    remaining = remaining.slice(endIndex + TMUX_CONTROL_END.length);
    if (session.currentCommand !== null) {
      processControlChunk(session, TMUX_CONTROL_END);
      debugLog("tmux.transport", "end marker treated as command output", {
        terminalId,
        sessionId: session.id,
        command: session.currentCommand.pending?.command ?? null,
      });
      continue;
    }
    if (controlSessions.has(session.id)) {
      debugLog("tmux.transport", "end marker detected", {
        terminalId,
        sessionId: session.id,
      });
      teardownControlSession(session, "transport-end-marker");
    }
    session = null;
  }

  if (shouldLogTransportChunk) {
    const activeSession = session
      ?? getControlSessionById(transportTerminalToSessionId.get(terminalId) ?? terminalId)
      ?? existingSession;
    if (activeSession) {
      recordTmuxTransportComplete(
        activeSession,
        terminalId,
        passthrough.length,
        (transportRawCarry.get(terminalId) ?? "").length
      );
    } else {
      debugLog("tmux.transport", "chunk complete", {
        terminalId,
        passthroughBytes: passthrough.length,
        remainingCarryLength: (transportRawCarry.get(terminalId) ?? "").length,
        activeSessionId: null,
      });
    }
  }

  return passthrough;
}

export function isTmuxPaneTerminal(terminalId: string): boolean {
  return getTerminalSession(terminalId)?.backendKind === "tmux-pane";
}

export function isTmuxWindowTerminal(terminalId: string): boolean {
  return getTerminalSession(terminalId)?.backendKind === "tmux-window";
}

export function resolvePreferredTerminalFocus(terminalId: string): string {
  const session = getTerminalSession(terminalId);
  if (session?.backendKind !== "tmux-window" || !session.tmuxControlSessionId || !session.tmuxWindowId) {
    return terminalId;
  }

  const controlSession = controlSessions.get(session.tmuxControlSessionId);
  const windowState = controlSession?.windows.get(session.tmuxWindowId);
  if (!controlSession || !windowState?.activePaneId) {
    return terminalId;
  }

  return controlSession.panes.get(windowState.activePaneId)?.terminalId ?? terminalId;
}

export async function clearTmuxTerminal(terminalId: string): Promise<boolean> {
  const preferredTerminalId = resolvePreferredTerminalFocus(terminalId);
  const pane = getTmuxPaneStateByTerminal(preferredTerminalId);
  const session = pane ? getControlSessionForTerminal(preferredTerminalId) : null;
  if (!pane || !session) {
    return false;
  }

  ensurePaneHistoryCaptureState(pane);
  pane.contentClearGeneration += 1;
  pane.initialContentCaptured = true;
  pane.historySize = 0;
  pane.lastHistoryCaptureSize = 0;
  pane.lastHistoryRefreshAt = Date.now();
  pane.lastHistoryRefreshDeferredLogAt = 0;
  pane.missedOutputSinceHistoryCapture = false;
  ensureInitialPaneCaptureState(session);
  session.pendingInitialPaneCaptures = session.pendingInitialPaneCaptures.filter(
    (paneId) => paneId !== pane.paneId
  );
  suppressPaneOutputActivity(session, pane.paneId, "clear-history");
  debugLog("tmux.action", "clear pane history", {
    terminalId,
    preferredTerminalId,
    sessionId: session.id,
    paneId: pane.paneId,
    generation: pane.contentClearGeneration,
  });

  await sendCommand(session, `clear-history -t ${pane.paneId}`);
  await sendCommand(session, `send-keys -t ${pane.paneId} C-l`);
  return true;
}

function getBracketedPastePayload(data: string): string | null {
  if (!data.startsWith(BRACKETED_PASTE_START) || !data.endsWith(BRACKETED_PASTE_END)) {
    return null;
  }

  return data.slice(
    BRACKETED_PASTE_START.length,
    data.length - BRACKETED_PASTE_END.length
  );
}

function chunkTmuxPasteBufferText(data: string): string[] {
  const chunks: string[] = [];
  let chunk = "";
  for (const char of data) {
    chunk += char;
    if (chunk.length >= TMUX_PASTE_BUFFER_CHUNK_SIZE) {
      chunks.push(chunk);
      chunk = "";
    }
  }
  if (chunk.length > 0) {
    chunks.push(chunk);
  }
  return chunks;
}

export async function sendPasteToTmuxTerminal(terminalId: string, data: string): Promise<boolean> {
  const pane = getTmuxPaneStateByTerminal(terminalId);
  const session = pane ? getControlSessionForTerminal(terminalId) : null;
  if (!pane || !session) {
    const terminal = getTerminalSession(terminalId);
    debugLog("tmux.paste", "missing pane/session", {
      terminalId,
      backendKind: terminal?.backendKind ?? null,
      tmuxControlSessionId: terminal?.tmuxControlSessionId ?? null,
      tmuxWindowId: terminal?.tmuxWindowId ?? null,
      tmuxPaneId: terminal?.tmuxPaneId ?? null,
      hasPane: Boolean(pane),
      hasSession: Boolean(session),
      preview: previewDebugText(data, 120),
    });
    return false;
  }

  const normalized = normalizeTmuxPasteBufferText(data);
  if (normalized.length === 0) {
    return true;
  }

  const bufferName = `dispatcher-paste-${Date.now().toString(36)}-${tmuxPasteBufferSequence++}`;
  const chunks = chunkTmuxPasteBufferText(normalized);
  debugLog("tmux.paste", "send", {
    terminalId,
    sessionId: session.id,
    paneId: pane.paneId,
    chars: normalized.length,
    chunks: chunks.length,
    bufferName,
    preview: previewDebugText(normalized, 120),
  });

  for (const [index, chunk] of chunks.entries()) {
    const appendFlag = index === 0 ? "" : " -a";
    await sendCommand(
      session,
      `set-buffer${appendFlag} -b ${bufferName} ${quoteTmuxCommandArgument(chunk)}`
    );
  }
  await sendCommand(session, `paste-buffer -p -d -b ${bufferName} -t ${pane.paneId}`);

  return true;
}

export async function sendInputToTmuxTerminal(terminalId: string, data: string): Promise<boolean> {
  const bracketedPastePayload = getBracketedPastePayload(data);
  if (bracketedPastePayload !== null) {
    return sendPasteToTmuxTerminal(terminalId, bracketedPastePayload);
  }

  const pane = getTmuxPaneStateByTerminal(terminalId);
  const session = pane ? getControlSessionForTerminal(terminalId) : null;
  if (!pane || !session) {
    const terminal = getTerminalSession(terminalId);
    debugLog("tmux.input", "missing pane/session", {
      terminalId,
      backendKind: terminal?.backendKind ?? null,
      tmuxControlSessionId: terminal?.tmuxControlSessionId ?? null,
      tmuxWindowId: terminal?.tmuxWindowId ?? null,
      tmuxPaneId: terminal?.tmuxPaneId ?? null,
      hasPane: Boolean(pane),
      hasSession: Boolean(session),
      runtimeSessionCount: controlSessions.size,
      runtimePaneBindingCount: paneTerminalToSessionId.size,
      runtimeWindowBindingCount: windowTerminalToSessionId.size,
      runtimeTransportBindingCount: transportTerminalToSessionId.size,
      preview: previewDebugText(data, 120),
    });
    return false;
  }

  debugLog("tmux.input", "send", {
    terminalId,
    sessionId: session.id,
    paneId: pane.paneId,
    bytes: data.length,
    preview: previewDebugText(data, 120),
  });

  for (const encodedChunk of encodeTmuxSendKeysHex(data)) {
    await sendCommand(session, `send-keys -t ${pane.paneId} -H ${encodedChunk}`);
  }

  return true;
}

export function handleTmuxTerminalFocus(terminalId: string) {
  const session = getControlSessionForTerminal(terminalId);
  if (!session) {
    return;
  }

  const preferredTerminalId = resolvePreferredTerminalFocus(terminalId);
  const pane = getTmuxPaneStateByTerminal(preferredTerminalId);
  const window = pane
    ? session.windows.get(pane.windowId) ?? null
    : getTmuxWindowStateByTerminal(terminalId);
  if (!window) {
    return;
  }

  const placement = adoptSessionPlacementFromWindow(session, window);
  debugLog("tmux.focus", "sync focus", {
    terminalId,
    sessionId: session.id,
    windowId: window.windowId,
    paneId: pane?.paneId ?? null,
    projectId: placement.projectId,
    parentNodeId: placement.parentNodeId,
  });

  suppressWindowOutputActivity(session, window.windowId, "focus-sync");
  void sendCommand(session, `select-window -t ${window.windowId}`).catch((error) => {
    debugLogError("tmux.focus", "select-window failed", error);
  });
  if (pane) {
    suppressPaneOutputActivity(session, pane.paneId, "focus-pane-sync");
    if (pane.initialContentCaptured) {
      void refreshPaneContentForDisplay(session, pane, "focus").catch((error) => {
        debugLogError("tmux.capture", "focus pane redraw failed", error);
      });
    } else {
      queueInitialPaneContentCapture(session, pane, {
        priority: true,
        reason: "focus",
      });
    }
    void sendCommand(session, `select-pane -t ${pane.paneId}`).catch((error) => {
      debugLogError("tmux.focus", "select-pane failed", error);
    });
  }
}

export async function createTmuxWindowForTerminal(terminalId: string): Promise<boolean> {
  const session = getControlSessionForTerminal(terminalId);
  const preferredTerminalId = resolvePreferredTerminalFocus(terminalId);
  const pane = getTmuxPaneStateByTerminal(preferredTerminalId);
  const window = pane
    ? session?.windows.get(pane.windowId) ?? null
    : getTmuxWindowStateByTerminal(terminalId);
  if (!session || !window) {
    debugLog("tmux.action", "new window skipped", {
      terminalId,
      preferredTerminalId,
      reason: !session ? "missing-session" : "missing-window",
      sessionId: session?.id ?? null,
      paneId: pane?.paneId ?? null,
      paneWindowId: pane?.windowId ?? null,
      sessionWindowIds: session ? [...session.windows.keys()] : [],
    });
    return false;
  }

  const placement = adoptSessionPlacementFromWindow(session, window);
  const command = buildTmuxNewWindowCommand({
    targetWindowId: window.windowId,
  });
  debugLog("tmux.action", "new window", {
    terminalId,
    sessionId: session.id,
    windowId: window.windowId,
    paneId: pane?.paneId ?? null,
    projectId: placement.projectId,
    parentNodeId: placement.parentNodeId,
    command,
  });
  const pendingAnchor: PendingNewWindowAnchor = {
    token: generateId(),
    anchorWindowId: window.windowId,
  };
  session.pendingNewWindowAnchors.push(pendingAnchor);
  try {
    await sendCommand(session, command);
  } catch (error) {
    session.pendingNewWindowAnchors = session.pendingNewWindowAnchors.filter(
      (anchor) => anchor.token !== pendingAnchor.token
    );
    throw error;
  }
  return true;
}

export async function splitTmuxTerminal(terminalId: string, direction: "horizontal" | "vertical"): Promise<boolean> {
  const pane = getTmuxPaneStateByTerminal(resolvePreferredTerminalFocus(terminalId));
  const session = pane ? getControlSessionForTerminal(terminalId) : null;
  if (!pane || !session) {
    return false;
  }

  const flag = direction === "horizontal" ? "-h" : "-v";
  debugLog("tmux.action", "split pane", {
    terminalId,
    sessionId: session.id,
    paneId: pane.paneId,
    direction,
  });
  await sendCommand(session, `split-window ${flag} -t ${pane.paneId}`);
  return true;
}

export async function closeTmuxTerminal(terminalId: string): Promise<boolean> {
  const terminal = getTerminalSession(terminalId);
  const session = getControlSessionForTerminal(terminalId);
  if (!terminal || !session) {
    return false;
  }

  if (terminal.backendKind === "tmux-window" && terminal.tmuxWindowId) {
    debugLog("tmux.action", "close window", {
      terminalId,
      sessionId: session.id,
      windowId: terminal.tmuxWindowId,
    });
    await sendCommand(session, `kill-window -t ${terminal.tmuxWindowId}`);
    return true;
  }

  if (terminal.backendKind === "tmux-pane" && terminal.tmuxPaneId && terminal.tmuxWindowId) {
    const paneCount = [...session.panes.values()].filter((pane) => pane.windowId === terminal.tmuxWindowId).length;
    debugLog("tmux.action", "close pane", {
      terminalId,
      sessionId: session.id,
      windowId: terminal.tmuxWindowId,
      paneId: terminal.tmuxPaneId,
      paneCount,
      closesWindow: paneCount <= 1,
    });
    if (paneCount <= 1) {
      await sendCommand(session, `kill-window -t ${terminal.tmuxWindowId}`);
    } else {
      await sendCommand(session, `kill-pane -t ${terminal.tmuxPaneId}`);
    }
    return true;
  }

  return false;
}

export async function renameTmuxTerminal(terminalId: string, title: string): Promise<boolean> {
  const terminal = getTerminalSession(terminalId);
  const session = getControlSessionForTerminal(terminalId);
  if (!terminal || !session || terminal.backendKind !== "tmux-window" || !terminal.tmuxWindowId) {
    return false;
  }

  debugLog("tmux.action", "rename window", {
    terminalId,
    sessionId: session.id,
    windowId: terminal.tmuxWindowId,
    title,
  });
  await sendCommand(session, `rename-window -t ${terminal.tmuxWindowId} ${quoteTmuxCommandArgument(title)}`);
  return true;
}

function getTmuxWindowGridSize(session: TmuxControlSession, windowId: string) {
  const panes = [...session.panes.values()].filter((pane) => pane.windowId === windowId);
  return {
    cols: Math.max(1, ...panes.map((pane) => pane.left + pane.width)),
    rows: Math.max(1, ...panes.map((pane) => pane.top + pane.height)),
  };
}

function applyTmuxWindowSize(
  session: TmuxControlSession,
  windowState: TmuxWindowState,
  cols: number,
  rows: number,
  details: Record<string, unknown>
): boolean {
  const nextCols = Math.max(2, Math.floor(cols));
  const nextRows = Math.max(1, Math.floor(rows));
  if (!Number.isFinite(nextCols) || !Number.isFinite(nextRows)) {
    return false;
  }

  const nextSize = `${nextCols}x${nextRows}`;
  ensureTmuxClientSizeState(session);
  if (session.windowSizes.get(windowState.windowId) === nextSize) {
    return false;
  }

  if (session.clientSize === nextSize) {
    session.windowSizes.set(windowState.windowId, nextSize);
    debugLog("tmux.size", "skip client resize for already-applied size", {
      sessionId: session.id,
      windowId: windowState.windowId,
      ...details,
      size: nextSize,
    });
    return false;
  }

  const previousClientSize = session.clientSize;
  markTmuxClientSize(session, nextSize);
  beginTmuxClientResizeLayoutSuppression(session, windowState.windowId);
  session.pendingWindowRedraws.add(windowState.windowId);
  debugLog("tmux.size", "sync window size", {
    sessionId: session.id,
    windowId: windowState.windowId,
    ...details,
    size: nextSize,
  });
  void sendCommand(session, `refresh-client -C ${nextSize}`)
    .then(() => {
      scheduleRefresh(session, windowState.windowId);
    })
    .catch((error) => {
      if (session.clientSize === nextSize) {
        session.clientSize = previousClientSize;
        for (const knownWindow of session.windows.values()) {
          if (session.windowSizes.get(knownWindow.windowId) === nextSize) {
            if (previousClientSize) {
              session.windowSizes.set(knownWindow.windowId, previousClientSize);
            } else {
              session.windowSizes.delete(knownWindow.windowId);
            }
          }
        }
      }
      session.pendingWindowRedraws.delete(windowState.windowId);
      debugLogError("tmux.size", "refresh-client failed", error);
    });
  return true;
}

export function syncTmuxWindowSize(layoutId: string, widthPx: number, heightPx: number) {
  const windowState = getTmuxWindowStateByTerminal(layoutId);
  const session = getControlSessionForTerminal(layoutId);
  if (!windowState || !session || !windowState.activePaneId) {
    return false;
  }

  if (isTmuxWindowUserPaneResizeLocked(session, windowState.windowId)) {
    debugLog("tmux.size", "skip window size sync during user pane resize", {
      layoutId,
      sessionId: session.id,
      windowId: windowState.windowId,
      widthPx,
      heightPx,
    });
    return false;
  }

  const activePaneTerminalId = session.panes.get(windowState.activePaneId)?.terminalId;
  if (!activePaneTerminalId) {
    return false;
  }

  const cellSize = getTerminalCellSize(activePaneTerminalId);
  if (!cellSize || cellSize.width <= 0 || cellSize.height <= 0) {
    debugLog("tmux.size", "missing cell size", {
      layoutId,
      sessionId: session.id,
      activePaneTerminalId,
      widthPx,
      heightPx,
    });
    return false;
  }

  const activePane = session.panes.get(windowState.activePaneId) ?? null;
  const totalWindowGrid = getTmuxWindowGridSize(session, windowState.windowId);
  const viewportSize = getTerminalViewportSize(activePaneTerminalId);
  const cols = Math.max(2, Math.floor(widthPx / cellSize.width));
  const rows = Math.max(1, Math.floor(heightPx / cellSize.height));
  return applyTmuxWindowSize(session, windowState, cols, rows, {
    layoutId,
    activePaneTerminalId,
    widthPx,
    heightPx,
    cellWidth: cellSize.width,
    cellHeight: cellSize.height,
    viewportWidthPx: viewportSize?.width ?? null,
    viewportHeightPx: viewportSize?.height ?? null,
    activePaneCols: activePane?.width ?? null,
    activePaneRows: activePane?.height ?? null,
    totalWindowCols: totalWindowGrid.cols,
    totalWindowRows: totalWindowGrid.rows,
    source: "outer-canvas",
  });
}

export function syncTmuxWindowSizeFromPaneTerminal(terminalId: string): boolean {
  const pane = getTmuxPaneStateByTerminal(terminalId);
  const session = pane ? getControlSessionForTerminal(terminalId) : null;
  const windowState = pane && session ? session.windows.get(pane.windowId) ?? null : null;
  if (!pane || !session || !windowState) {
    return false;
  }

  if (isTmuxWindowUserPaneResizeLocked(session, pane.windowId)) {
    debugLog("tmux.size", "skip pane viewport sync during user pane resize", {
      terminalId,
      sessionId: session.id,
      windowId: pane.windowId,
      paneId: pane.paneId,
    });
    return false;
  }

  const cellSize = getTerminalCellSize(terminalId);
  const viewportSize = getTerminalViewportSize(terminalId);
  if (!cellSize || !viewportSize || cellSize.width <= 0 || cellSize.height <= 0) {
    debugLog("tmux.size", "missing pane viewport metrics", {
      terminalId,
      sessionId: session.id,
      windowId: pane.windowId,
      hasCellSize: Boolean(cellSize),
      hasViewportSize: Boolean(viewportSize),
    });
    return false;
  }

  const totalWindowGrid = getTmuxWindowGridSize(session, pane.windowId);
  const paneCount = [...session.panes.values()].filter((candidate) => candidate.windowId === pane.windowId).length;
  if (paneCount > 1) {
    debugLog("tmux.size", "skip pane viewport sync for split window", {
      terminalId,
      sessionId: session.id,
      windowId: pane.windowId,
      paneId: pane.paneId,
      paneCount,
      viewportWidthPx: viewportSize.width,
      viewportHeightPx: viewportSize.height,
      cellWidth: cellSize.width,
      cellHeight: cellSize.height,
      paneCols: pane.width,
      paneRows: pane.height,
      totalWindowCols: totalWindowGrid.cols,
      totalWindowRows: totalWindowGrid.rows,
    });
    return false;
  }

  const inferredWindowSize = computeTmuxWindowSizeFromPaneViewport({
    viewportWidthPx: viewportSize.width,
    viewportHeightPx: viewportSize.height,
    cellWidthPx: cellSize.width,
    cellHeightPx: cellSize.height,
    activePaneCols: pane.width,
    activePaneRows: pane.height,
    totalWindowCols: totalWindowGrid.cols,
    totalWindowRows: totalWindowGrid.rows,
  });
  if (!inferredWindowSize) {
    return false;
  }

  return applyTmuxWindowSize(session, windowState, inferredWindowSize.cols, inferredWindowSize.rows, {
    terminalId,
    paneId: pane.paneId,
    viewportWidthPx: viewportSize.width,
    viewportHeightPx: viewportSize.height,
    cellWidth: cellSize.width,
    cellHeight: cellSize.height,
    activePaneCols: pane.width,
    activePaneRows: pane.height,
    totalWindowCols: totalWindowGrid.cols,
    totalWindowRows: totalWindowGrid.rows,
    source: "pane-resize-observer",
  });
}

export function isTmuxTransportTerminal(terminalId: string): boolean {
  return getTerminalSession(terminalId)?.backendKind === "tmux-transport";
}

export function isLiveTmuxTerminal(terminalId: string): boolean {
  const terminal = getTerminalSession(terminalId);
  if (!terminal?.tmuxControlSessionId) {
    return false;
  }

  return (
    terminal.backendKind === "tmux-transport"
    || terminal.backendKind === "tmux-window"
    || terminal.backendKind === "tmux-pane"
  );
}

export function isDisconnectedTmuxPlaceholderTerminal(terminalId: string): boolean {
  const terminal = getTerminalSession(terminalId);
  if (!terminal || terminal.tmuxControlSessionId) {
    return false;
  }

  return terminal.backendKind === "tmux-window" || terminal.backendKind === "tmux-pane";
}

export function getTmuxLayoutKeyForTerminal(terminalId: string): string | null {
  const terminal = getTerminalSession(terminalId);
  if (!terminal?.tmuxControlSessionId) {
    return null;
  }
  const layouts = useLayoutStore.getState().layouts;
  return findLayoutKeyForTerminal(layouts, terminalId);
}

export function beginTmuxPaneResizeByTerminal(terminalId: string): boolean {
  const pane = getTmuxPaneStateByTerminal(terminalId);
  const session = pane ? getControlSessionForTerminal(terminalId) : null;
  if (!pane || !session) {
    return false;
  }

  lockTmuxWindowForUserPaneResize(session, pane.windowId, "drag-start");
  return true;
}

export function resizeTmuxPaneByTerminal(
  terminalId: string,
  direction: "horizontal" | "vertical",
  delta: number
): boolean {
  const pane = getTmuxPaneStateByTerminal(terminalId);
  const session = pane ? getControlSessionForTerminal(terminalId) : null;
  if (!pane || !session) {
    return false;
  }

  if (delta === 0) {
    clearTmuxWindowUserPaneResizeLock(session, pane.windowId, "drag-end-noop");
    return false;
  }

  lockTmuxWindowForUserPaneResize(session, pane.windowId, "resize-pane-command");
  const absDelta = Math.abs(delta);
  let flag: string;
  if (direction === "horizontal") {
    flag = delta > 0 ? "-R" : "-L";
  } else {
    flag = delta > 0 ? "-D" : "-U";
  }

  debugLog("tmux.action", "resize pane", {
    terminalId,
    sessionId: session.id,
    paneId: pane.paneId,
    direction,
    delta,
    flag,
  });
  void sendCommand(session, `resize-pane -t ${pane.paneId} ${flag} ${absDelta}`)
    .then(() => {
      clearTmuxWindowUserPaneResizeLock(session, pane.windowId, "resize-pane-complete");
      scheduleRefresh(session, pane.windowId);
    })
    .catch((error) => {
      clearTmuxWindowUserPaneResizeLock(session, pane.windowId, "resize-pane-failed");
      scheduleRefresh(session, pane.windowId);
      debugLogError("tmux.action", "resize-pane failed", error);
    });
  return true;
}

export function handleTransportTerminalExit(terminalId: string) {
  const sessionId = transportTerminalToSessionId.get(terminalId);
  if (!sessionId) {
    return;
  }

  const session = controlSessions.get(sessionId);
  if (!session) {
    return;
  }

  debugLog("tmux.session", "transport terminal exited", {
    terminalId,
    sessionId: session.id,
    windows: session.windows.size,
    panes: session.panes.size,
  });

  teardownControlSession(session, "transport-pty-exit");
}
