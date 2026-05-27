import { useEffect } from "react";
import {
  captureTerminalScreenshot,
  captureTerminalVisualSnapshot,
  hasTerminalFrontend,
} from "./useTerminalBridge";
import { findLayoutKeyForTerminal } from "../lib/layoutUtils";
import { pushScreenshotDebug } from "../lib/screenshotDebug";
import { writeDebugArtifact } from "../lib/tauriCommands";
import {
  buildCompoundScreenshotHashInput,
  buildTerminalVisualHashInput,
  getTabRootTerminalIds,
  getTabStatusTerminalIds,
  getTabTerminalIds,
  summarizeTerminalVisualChange,
  type TerminalVisualChangeSummary,
  type TerminalVisualTextSnapshot,
} from "../lib/terminalScreenshotHash";
import { resolveTerminalScreenshotStatus } from "../lib/terminalScreenshotStatus";
import { debugLog, previewDebugText } from "../lib/debugLog";
import { pushStatusDebug } from "../lib/statusDebug";
import { isDisconnectedTmuxPlaceholderTerminal } from "../lib/tmuxControl";
import {
  getActiveStatusResizeSuppression,
  shouldIgnoreStatusResizeChange,
} from "../lib/statusResizeSuppression";
import { useLayoutStore } from "../stores/useLayoutStore";
import { useTerminalStore } from "../stores/useTerminalStore";
import type { TerminalSession } from "../types/terminal";

const SCREENSHOT_INTERVAL_MS = 5_000;
// A stable tab becomes stale after this window. Background stale tabs pulse
// until the user looks at them; acknowledged stale tabs turn brown.
const SCREENSHOT_INACTIVITY_MS = 10_000;
// Long inactivity applies to brown tabs only. Unacknowledged stale tabs keep
// pulsing because they still need the user's attention.
const SCREENSHOT_LONG_INACTIVITY_MS = 60 * 60 * 1000;
// Tmux focus can redraw panes without real agent progress. This short window
// prevents those focus-only redraws from clearing pulse/brown state.
const FOCUS_VISUAL_SUPPRESSION_MS = SCREENSHOT_INTERVAL_MS + 2_500;
const SCREENSHOT_ARTIFACT_INTERVAL_MS = 5 * 60 * 1000;
const SCREENSHOT_ARTIFACT_GLOBAL_INTERVAL_MS = 30_000;
const MAX_VISUAL_TABS_PER_SAMPLE = 6;
const MAX_SCREENSHOT_ARTIFACT_COMPONENTS = 4;
const MAX_SCREENSHOT_IMAGE_CAPTURES_PER_SAMPLE = 1;
const MAX_SCREENSHOT_ARTIFACT_LINES = 120;
const MAX_SCREENSHOT_ARTIFACT_LINE_CHARS = 240;

type ScreenshotSample = {
  terminalId: string;
  screenshot?: string;
  snapshot: TerminalVisualTextSnapshot;
};

type FocusVisualSuppression = {
  startedAt: number;
  until: number;
  reason: string;
};

function isTmuxStatusSession(session: TerminalSession): boolean {
  return session.backendKind === "tmux-window" || session.backendKind === "tmux-pane";
}

export function shouldUseTimestampOnlyStatus(sessions: readonly TerminalSession[]): boolean {
  // Tmux control mode already gives us a precise signal when pane data arrives.
  // Visual sampling is weaker for tmux because focus redraws, cursor updates,
  // and capture replays can change the xterm buffer without agent progress.
  return sessions.some(isTmuxStatusSession);
}

export function resolveTimestampStatusChangedAt(args: {
  timestampOnlyStatus: boolean;
  latestActivityAt: number;
  previousChangedAt: number;
  now: number;
}): { changed: boolean; changedAt: number } {
  const hasTimestampBaseline = args.previousChangedAt > 0;
  const changed = hasTimestampBaseline && args.latestActivityAt > args.previousChangedAt;
  const changedAt = args.timestampOnlyStatus
    ? (args.latestActivityAt > 0 ? args.latestActivityAt : args.now)
    : changed || !hasTimestampBaseline
      ? (args.latestActivityAt > 0 ? args.latestActivityAt : args.now)
      : args.previousChangedAt;

  return { changed, changedAt };
}

async function hashScreenshot(screenshot: string): Promise<string> {
  const bytes = new TextEncoder().encode(screenshot);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

function getActiveTabRootTerminalId(): string | null {
  const activeTerminalId = useTerminalStore.getState().activeTerminalId;
  if (!activeTerminalId) {
    return null;
  }

  const layouts = useLayoutStore.getState().layouts;
  return findLayoutKeyForTerminal(layouts, activeTerminalId) ?? activeTerminalId;
}

export function shouldIgnoreTmuxFocusVisualChange(args: {
  changed: boolean;
  hasActiveFocusVisualSuppression: boolean;
  hasTmuxStatusSession: boolean;
  lastUserInputAt: number;
  lastOutputAt: number;
  suppressionStartedAt: number;
}): boolean {
  return (
    args.changed
    && args.hasActiveFocusVisualSuppression
    && args.hasTmuxStatusSession
    && args.lastUserInputAt <= args.suppressionStartedAt
    && args.lastOutputAt <= args.suppressionStartedAt
  );
}

export function shouldWriteScreenshotDebugArtifact(args: {
  isBaselineCapture: boolean;
  statusTransitioned: boolean;
  now: number;
  lastTabArtifactAt: number;
  lastGlobalArtifactAt: number;
  perTabIntervalMs?: number;
  globalIntervalMs?: number;
}): boolean {
  if (args.isBaselineCapture || !args.statusTransitioned) {
    return false;
  }

  const perTabIntervalMs = args.perTabIntervalMs ?? SCREENSHOT_ARTIFACT_INTERVAL_MS;
  const globalIntervalMs = args.globalIntervalMs ?? SCREENSHOT_ARTIFACT_GLOBAL_INTERVAL_MS;
  return (
    args.now - args.lastTabArtifactAt >= perTabIntervalMs
    && args.now - args.lastGlobalArtifactAt >= globalIntervalMs
  );
}

function sanitizeArtifactNamePart(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  return sanitized.length > 0 ? sanitized : "terminal";
}

function artifactTimestamp(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, "-");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "\"":
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
}

function buildScreenshotArtifactHtml(args: {
  title: string;
  imageDataUrl?: string;
  details: unknown;
}): string {
  return [
    "<!doctype html>",
    "<html>",
    "<head>",
    "  <meta charset=\"utf-8\">",
    `  <title>${escapeHtml(args.title)}</title>`,
    "  <style>",
    "    body { margin: 0; padding: 16px; background: #111; color: #ddd; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }",
    "    img { display: block; max-width: 100%; height: auto; image-rendering: auto; border: 1px solid #333; }",
    "    pre { white-space: pre-wrap; overflow-wrap: anywhere; }",
    "  </style>",
    "</head>",
    "<body>",
    `  <h1>${escapeHtml(args.title)}</h1>`,
    args.imageDataUrl
      ? `  <img src=\"${args.imageDataUrl}\" alt=\"${escapeHtml(args.title)}\">`
      : "",
    `  <pre>${escapeHtml(JSON.stringify(args.details, null, 2))}</pre>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

function buildVisibleLinePreview(snapshot: TerminalVisualTextSnapshot) {
  const startRow = Math.max(0, snapshot.lines.length - MAX_SCREENSHOT_ARTIFACT_LINES);
  return snapshot.lines.slice(startRow).map((line, index) => ({
    row: startRow + index,
    text: previewDebugText(line, MAX_SCREENSHOT_ARTIFACT_LINE_CHARS),
  }));
}

function attachScreenshotImages(
  samples: readonly ScreenshotSample[],
  options: { maxImages: number }
): ScreenshotSample[] {
  let remainingImages = Math.max(0, options.maxImages);

  return samples.map((sample) => {
    if (remainingImages <= 0) {
      return sample;
    }

    const screenshot = captureTerminalScreenshot(sample.terminalId);
    if (!screenshot) {
      return sample;
    }

    remainingImages -= 1;
    return {
      ...sample,
      screenshot,
    };
  });
}

function getCompleteComponentImageDataUrls(samples: readonly ScreenshotSample[]): string[] | undefined {
  const imageDataUrls = samples.map((sample) => sample.screenshot);
  if (imageDataUrls.some((value) => !value)) {
    return undefined;
  }

  return imageDataUrls as string[];
}

function getStatusDotSemantic(args: {
  hasDetectedActivity: boolean;
  nextNeedsAttention: boolean;
  nextPossiblyDone: boolean;
  nextLongInactive: boolean;
}): string {
  if (!args.hasDetectedActivity) {
    return "gray-idle";
  }
  if (args.nextNeedsAttention) {
    return "green-needs-attention";
  }
  if (args.nextLongInactive) {
    return "gray-long-inactive";
  }
  if (args.nextPossiblyDone) {
    return "brown-possibly-done";
  }
  return "green-active";
}

export function selectVisualSampleTabRootTerminalIds(args: {
  tabRootTerminalIds: string[];
  activeTabRootTerminalId: string | null;
  maxTabs: number;
  cursor: number;
  canSample: (tabRootTerminalId: string) => boolean;
}): { selected: string[]; nextCursor: number } {
  if (args.maxTabs <= 0 || args.tabRootTerminalIds.length === 0) {
    return { selected: [], nextCursor: args.cursor };
  }

  const visuallyReady = args.tabRootTerminalIds.filter(args.canSample);
  if (visuallyReady.length === 0) {
    return { selected: [], nextCursor: 0 };
  }

  const selected: string[] = [];
  const activeTabRootTerminalId = args.activeTabRootTerminalId;
  if (activeTabRootTerminalId !== null && visuallyReady.includes(activeTabRootTerminalId)) {
    selected.push(activeTabRootTerminalId);
  }

  const remaining = Math.max(0, args.maxTabs - selected.length);
  const candidates = visuallyReady.filter((terminalId) => terminalId !== activeTabRootTerminalId);
  if (remaining === 0 || candidates.length === 0) {
    return { selected, nextCursor: args.cursor % Math.max(candidates.length, 1) };
  }

  const start = args.cursor % candidates.length;
  for (let offset = 0; offset < Math.min(remaining, candidates.length); offset += 1) {
    selected.push(candidates[(start + offset) % candidates.length]);
  }

  return {
    selected,
    nextCursor: (start + remaining) % candidates.length,
  };
}

async function writeScreenshotDebugArtifacts(args: {
  now: number;
  tabRootTerminalId: string;
  activeTabRootTerminalId: string | null;
  terminalIds: string[];
  statusTerminalIds: string[];
  screenshots: ScreenshotSample[];
  componentHashes: string[];
  hash: string;
  previousHash: string | null;
  visualChange: TerminalVisualChangeSummary;
  changed: boolean;
  changedForStatus: boolean;
  ignoreVisualChange: boolean;
  visualChangeIgnoredReason?: string;
  hasDetectedActivity: boolean;
  isActiveTab: boolean;
  lastUserInputAt: number;
  lastOutputAt: number;
  effectiveChangedAt: number;
  acknowledgedTime: number;
  idleStartedAt: number;
  staleStartedAt: number;
  brownStartedAt: number | null;
  nextNeedsAttention: boolean;
  nextPossiblyDone: boolean;
  nextLongInactive: boolean;
  shouldKeepAttentionUntilFocus: boolean;
  shouldKeepBrownUntilInput: boolean;
  sessions: TerminalSession[];
  previousStatusSnapshot: string | null;
  nextStatusSnapshot: string;
}) {
  const prefix = [
    artifactTimestamp(args.now),
    sanitizeArtifactNamePart(args.tabRootTerminalId),
  ].join("_");
  const statusDotSemantic = getStatusDotSemantic(args);
  const metadata = {
    timestamp: new Date(args.now).toISOString(),
    tabRootTerminalId: args.tabRootTerminalId,
    activeTabRootTerminalId: args.activeTabRootTerminalId,
    terminalIds: args.terminalIds,
    statusTerminalIds: args.statusTerminalIds,
    statusDotSemantic,
    previousStatusSnapshot: args.previousStatusSnapshot,
    nextStatusSnapshot: args.nextStatusSnapshot,
    hash: args.hash,
    previousHash: args.previousHash,
    componentHashes: args.componentHashes,
    changed: args.changed,
    changedForStatus: args.changedForStatus,
    ignoreVisualChange: args.ignoreVisualChange,
    visualChangeIgnoredReason: args.visualChangeIgnoredReason ?? null,
    exactChanged: args.visualChange.exactChanged,
    repeatingHashOscillation: args.visualChange.repeatingHashOscillation,
    hasThreeSamples: args.visualChange.hasThreeSamples,
    changedRows: args.visualChange.changedRows,
    changedChars: args.visualChange.changedChars,
    changedRowRatio: args.visualChange.changedRowRatio,
    changedCharRatio: args.visualChange.changedCharRatio,
    hasDetectedActivity: args.hasDetectedActivity,
    isActiveTab: args.isActiveTab,
    lastUserInputAt: args.lastUserInputAt,
    lastOutputAt: args.lastOutputAt,
    effectiveChangedAt: args.effectiveChangedAt,
    acknowledgedTime: args.acknowledgedTime,
    idleStartedAt: args.idleStartedAt,
    staleStartedAt: args.staleStartedAt,
    brownStartedAt: args.brownStartedAt,
    nextNeedsAttention: args.nextNeedsAttention,
    nextPossiblyDone: args.nextPossiblyDone,
    nextLongInactive: args.nextLongInactive,
    shouldKeepAttentionUntilFocus: args.shouldKeepAttentionUntilFocus,
    shouldKeepBrownUntilInput: args.shouldKeepBrownUntilInput,
    sessions: args.sessions.map((session) => ({
      id: session.id,
      title: session.title,
      backendKind: session.backendKind,
      hasDetectedActivity: session.hasDetectedActivity,
      lastUserInputAt: session.lastUserInputAt,
      lastOutputAt: session.lastOutputAt,
      isNeedsAttention: session.isNeedsAttention,
      isPossiblyDone: session.isPossiblyDone,
      isLongInactive: session.isLongInactive,
      isRecentlyFocused: session.isRecentlyFocused,
      tmuxControlSessionId: session.tmuxControlSessionId,
      tmuxWindowId: session.tmuxWindowId,
      tmuxPaneId: session.tmuxPaneId,
    })),
    components: args.screenshots.map(({ terminalId, snapshot }, index) => ({
      terminalId,
      hash: args.componentHashes[index] ?? null,
      cols: snapshot.cols,
      rows: snapshot.rows,
      lineCount: snapshot.lines.length,
      lines: buildVisibleLinePreview(snapshot),
    })),
  };

  const paths = [
    await writeDebugArtifact(`${prefix}.json`, JSON.stringify(metadata, null, 2)),
  ];

  for (const [index, sample] of args.screenshots
    .slice(0, MAX_SCREENSHOT_ARTIFACT_COMPONENTS)
    .entries()) {
    if (!sample.screenshot) {
      continue;
    }
    const title = `${args.tabRootTerminalId} component ${index} ${sample.terminalId}`;
    paths.push(await writeDebugArtifact(
      `${prefix}_${index}_${sanitizeArtifactNamePart(sample.terminalId)}.html`,
      buildScreenshotArtifactHtml({
        title,
        imageDataUrl: sample.screenshot,
        details: {
          tabRootTerminalId: args.tabRootTerminalId,
          terminalId: sample.terminalId,
          componentHash: args.componentHashes[index] ?? null,
          statusDotSemantic,
          nextStatusSnapshot: args.nextStatusSnapshot,
          changed: args.changed,
          changedForStatus: args.changedForStatus,
          ignoreVisualChange: args.ignoreVisualChange,
          visualChangeIgnoredReason: args.visualChangeIgnoredReason ?? null,
          exactChanged: args.visualChange.exactChanged,
          repeatingHashOscillation: args.visualChange.repeatingHashOscillation,
          changedRows: args.visualChange.changedRows,
          changedChars: args.visualChange.changedChars,
        },
      })
    ));
  }

  debugLog("status.monitor", "wrote screenshot artifacts", {
    tabRootTerminalId: args.tabRootTerminalId,
    statusDotSemantic,
    paths,
  });
}

export function useTerminalScreenshotMonitor() {
  useEffect(() => {
    const previousHashes = new Map<string, string>();
    const previousComponents = new Map<string, TerminalVisualTextSnapshot[]>();
    const recentHashes = new Map<string, string[]>();
    const previousTabSignatures = new Map<string, string>();
    const previousStatusSnapshots = new Map<string, string>();
    const lastChangedAt = new Map<string, number>();
    const acknowledgedAt = new Map<string, number>();
    const focusVisualSuppressions = new Map<string, FocusVisualSuppression>();
    const lastArtifactAt = new Map<string, number>();
    const scheduledSamples = new Set<number>();
    let lastGlobalArtifactAt = 0;
    let visualSampleCursor = 0;
    let isSampling = false;
    let isDisposed = false;

    const clearTabState = (tabRootTerminalId: string) => {
      previousHashes.delete(tabRootTerminalId);
      previousComponents.delete(tabRootTerminalId);
      recentHashes.delete(tabRootTerminalId);
      previousTabSignatures.delete(tabRootTerminalId);
      previousStatusSnapshots.delete(tabRootTerminalId);
      lastChangedAt.delete(tabRootTerminalId);
      acknowledgedAt.delete(tabRootTerminalId);
      focusVisualSuppressions.delete(tabRootTerminalId);
      lastArtifactAt.delete(tabRootTerminalId);
    };

    const applyTimestampStatus = (args: {
      tabRootTerminalId: string;
      now: number;
      layouts: ReturnType<typeof useLayoutStore.getState>["layouts"];
      sessionIds: Set<string>;
      activeTabRootTerminalId: string | null;
      reason: string;
    }) => {
      const terminalIds = getTabTerminalIds(args.layouts, args.tabRootTerminalId, args.sessionIds);
      const statusTerminalIds = getTabStatusTerminalIds(args.layouts, args.tabRootTerminalId, args.sessionIds);
      if (terminalIds.length === 0 || statusTerminalIds.length === 0) {
        return;
      }

      const latestStore = useTerminalStore.getState();
      const latestSessions = statusTerminalIds
        .map((terminalId) => latestStore.sessions[terminalId])
        .filter((session): session is TerminalSession => session !== undefined);
      if (latestSessions.length !== statusTerminalIds.length) {
        return;
      }

      const previousActivityAt = lastChangedAt.get(args.tabRootTerminalId) ?? 0;
      const lastUserInputAt = latestSessions.reduce(
        (maxTime, session) => Math.max(maxTime, session.lastUserInputAt ?? 0),
        0
      );
      const lastOutputAt = latestSessions.reduce(
        (maxTime, session) => Math.max(maxTime, session.lastOutputAt ?? 0),
        0
      );
      const latestActivityAt = Math.max(lastUserInputAt, lastOutputAt);
      const timestampOnlyStatus = shouldUseTimestampOnlyStatus(latestSessions);
      const { changed, changedAt } = resolveTimestampStatusChangedAt({
        timestampOnlyStatus,
        latestActivityAt,
        previousChangedAt: previousActivityAt,
        now: args.now,
      });
      const effectiveChangedAt = Math.max(changedAt, lastUserInputAt, lastOutputAt);
      const hasDetectedActivity =
        latestSessions.some((session) => session.hasDetectedActivity)
        || lastUserInputAt > 0
        || lastOutputAt > 0;
      const acknowledgedTime = acknowledgedAt.get(args.tabRootTerminalId) ?? 0;
      const isActiveTab = args.activeTabRootTerminalId === args.tabRootTerminalId;
      const {
        hasAcknowledgedCurrentOutput,
        idleStartedAt,
        staleStartedAt,
        brownStartedAt,
        changedForStatus,
        shouldKeepAttentionUntilFocus,
        shouldKeepBrownUntilInput,
        nextNeedsAttention,
        nextPossiblyDone,
        nextLongInactive,
      } = resolveTerminalScreenshotStatus({
        hasDetectedActivity,
        isActiveTab,
        changed,
        ignoreVisualChange: false,
        now: args.now,
        effectiveChangedAt,
        acknowledgedTime,
        wasNeedsAttention: latestSessions.some((session) => session.isNeedsAttention),
        wasPossiblyDone: latestSessions.some((session) => session.isPossiblyDone),
        inactivityMs: SCREENSHOT_INACTIVITY_MS,
        longInactivityMs: SCREENSHOT_LONG_INACTIVITY_MS,
      });
      const statusDotSemantic = getStatusDotSemantic({
        hasDetectedActivity,
        nextNeedsAttention,
        nextPossiblyDone,
        nextLongInactive,
      });
      const nextStatusSnapshot = [
        hasDetectedActivity ? "activity" : "idle",
        isActiveTab ? "active" : "background",
        changedForStatus ? "changed" : "stable",
        hasAcknowledgedCurrentOutput ? "ack" : "unack",
        nextNeedsAttention ? "attention" : "no-attention",
        nextPossiblyDone ? "done" : "not-done",
        nextLongInactive ? "long-idle" : "not-long-idle",
      ].join("|");
      const previousStatusSnapshot = previousStatusSnapshots.get(args.tabRootTerminalId) ?? null;
      const statusTransitioned = previousStatusSnapshot !== nextStatusSnapshot;
      const statusDebugDetails = {
        tabRootTerminalId: args.tabRootTerminalId,
        previousStatusSnapshot,
        nextStatusSnapshot,
        activeTabRootTerminalId: args.activeTabRootTerminalId,
        terminalIds,
        statusTerminalIds,
        statusDotSemantic,
        changed,
        changedForStatus,
        ignoreVisualChange: false,
        visualChangeIgnoredReason: undefined,
        focusVisualSuppressionUntil: focusVisualSuppressions.get(args.tabRootTerminalId)?.until ?? null,
        hasDetectedActivity,
        isActiveTab,
        lastUserInputAt,
        lastOutputAt,
        effectiveChangedAt,
        acknowledgedTime,
        idleStartedAt,
        staleStartedAt,
        brownStartedAt,
        exactChanged: false,
        repeatingHashOscillation: false,
        hasThreeSamples: false,
        changedRows: 0,
        changedChars: 0,
        changedRowRatio: 0,
        changedCharRatio: 0,
        nextNeedsAttention,
        nextPossiblyDone,
        nextLongInactive,
        shouldKeepAttentionUntilFocus,
        shouldKeepBrownUntilInput,
        visualSampled: false,
        reason: args.reason,
        timestampOnlyStatus,
        backendKinds: [...new Set(latestSessions.map((session) => session.backendKind))],
      };

      if (statusTransitioned) {
        previousStatusSnapshots.set(args.tabRootTerminalId, nextStatusSnapshot);
        debugLog("status.monitor", "timestamp transition", statusDebugDetails);
        pushStatusDebug({
          terminalId: args.tabRootTerminalId,
          event: "transition",
          ...statusDebugDetails,
        });
      }

      lastChangedAt.set(args.tabRootTerminalId, changedAt);
      for (const terminalId of statusTerminalIds) {
        latestStore.setDetectedActivity(terminalId, hasDetectedActivity);
        latestStore.setNeedsAttention(terminalId, nextNeedsAttention);
        latestStore.setPossiblyDone(terminalId, nextPossiblyDone);
        latestStore.setLongInactive(terminalId, nextLongInactive);
      }
    };

    const acknowledgeTab = (
      tabRootTerminalId: string | null,
      sessionIds: Set<string>,
      now: number,
      reason: string
    ) => {
      if (!tabRootTerminalId) {
        return;
      }

      const store = useTerminalStore.getState();
      const layouts = useLayoutStore.getState().layouts;
      const statusTerminalIds = getTabStatusTerminalIds(layouts, tabRootTerminalId, sessionIds);
      const statusSessions = statusTerminalIds
        .map((terminalId) => store.sessions[terminalId])
        .filter((session): session is TerminalSession => session !== undefined);
      const previousAcknowledgedAt = acknowledgedAt.get(tabRootTerminalId) ?? 0;
      // Acknowledgement is intentionally separate from activity. Focusing a
      // pulsing tab means "the user has seen this stale output"; it must clear
      // the pulse and let the next monitor pass mark it brown if nothing real
      // changed. It must not move the output's idle baseline forward, because
      // that would force a second inactivity window after focus.
      acknowledgedAt.set(tabRootTerminalId, now);
      const focusSuppression =
        reason === "active-terminal-changed" && statusSessions.some(isTmuxStatusSession)
          ? {
              startedAt: now,
              until: now + FOCUS_VISUAL_SUPPRESSION_MS,
              reason,
            }
          : null;
      const suppressedTabRootTerminalIds: string[] = [];
      if (focusSuppression) {
        const tmuxControlSessionIds = new Set(
          statusSessions
            .map((session) => session.tmuxControlSessionId)
            .filter((id): id is string => Boolean(id))
        );
        const relatedTabRootTerminalIds = tmuxControlSessionIds.size > 0
          ? getTabRootTerminalIds(layouts, sessionIds).filter((rootTerminalId) => {
              const rootStatusTerminalIds = getTabStatusTerminalIds(layouts, rootTerminalId, sessionIds);
              const rootStatusSessions = rootStatusTerminalIds
                .map((terminalId) => store.sessions[terminalId])
                .filter((session): session is TerminalSession => session !== undefined);
              return rootStatusSessions.some((session) => {
                if (!isTmuxStatusSession(session)) {
                  return false;
                }

                if (!session.tmuxControlSessionId) {
                  return true;
                }

                if (tmuxControlSessionIds.has(session.tmuxControlSessionId)) {
                  return true;
                }

                // A tmux focus/resize refresh can fan out as layout notifications on
                // sibling control sessions attached to the same server. We suppress
                // all tmux roots briefly so that redraw-only churn does not clear
                // background brown/attention state.
                return true;
              });
            })
          : [tabRootTerminalId];
        for (const rootTerminalId of new Set([tabRootTerminalId, ...relatedTabRootTerminalIds])) {
          focusVisualSuppressions.set(rootTerminalId, focusSuppression);
          suppressedTabRootTerminalIds.push(rootTerminalId);
        }
      }
      for (const terminalId of statusTerminalIds) {
        const session = store.sessions[terminalId];
        if (session?.isNeedsAttention) {
          store.setNeedsAttention(terminalId, false);
        }
      }
      debugLog("status.monitor", "focus acknowledge", {
        tabRootTerminalId,
        reason,
        previousAcknowledgedAt,
        acknowledgedAt: now,
        statusTerminalIds,
        focusVisualSuppressionUntil: focusSuppression?.until ?? null,
        suppressedTabRootTerminalIds,
      });
      pushStatusDebug({
        terminalId: tabRootTerminalId,
        event: "acknowledge",
        reason,
        statusTerminalIds,
        previousAcknowledgedAt,
        acknowledgedTime: now,
        focusVisualSuppressionUntil: focusSuppression?.until ?? null,
        terminalIds: suppressedTabRootTerminalIds,
        backendKinds: [...new Set(statusSessions.map((session) => session.backendKind))],
      });
    };

    const sampleTabs = async (tabRootTerminalIds: string[]) => {
      if (isSampling || isDisposed) {
        return;
      }

      isSampling = true;
      const now = Date.now();
      try {
        const store = useTerminalStore.getState();
        const layouts = useLayoutStore.getState().layouts;
        const sessionIds = new Set(Object.keys(store.sessions));
        const activeTabRootTerminalId = getActiveTabRootTerminalId();
        const activeTabRoots = new Set(getTabRootTerminalIds(layouts, sessionIds));

        for (const tabRootTerminalId of new Set([
          ...previousHashes.keys(),
          ...previousTabSignatures.keys(),
          ...lastChangedAt.keys(),
          ...acknowledgedAt.keys(),
        ])) {
          if (!activeTabRoots.has(tabRootTerminalId)) {
            clearTabState(tabRootTerminalId);
          }
        }

        for (const tabRootTerminalId of tabRootTerminalIds) {
          const terminalIds = getTabTerminalIds(layouts, tabRootTerminalId, sessionIds);
          const statusTerminalIds = getTabStatusTerminalIds(layouts, tabRootTerminalId, sessionIds);
          if (terminalIds.length === 0) {
            continue;
          }

          const screenshots: ScreenshotSample[] = [];
          let isReady = true;
          for (const terminalId of terminalIds) {
            const session = useTerminalStore.getState().sessions[terminalId];
            if (!session) {
              isReady = false;
              break;
            }

            if (isDisconnectedTmuxPlaceholderTerminal(terminalId)) {
              isReady = false;
              break;
            }

            if (!hasTerminalFrontend(terminalId)) {
              isReady = false;
              break;
            }

            const visualSnapshot = captureTerminalVisualSnapshot(terminalId);
            if (visualSnapshot === null) {
              isReady = false;
              break;
            }

            screenshots.push({
              terminalId,
              snapshot: {
                terminalId: visualSnapshot.terminalId,
                cols: visualSnapshot.cols,
                rows: visualSnapshot.rows,
                lines: visualSnapshot.lines,
              },
            });
          }

          if (!isReady || screenshots.length !== terminalIds.length) {
            applyTimestampStatus({
              tabRootTerminalId,
              now,
              layouts,
              sessionIds,
              activeTabRootTerminalId,
              reason: "visual-not-ready",
            });
            continue;
          }

          const componentHashes = await Promise.all(
            screenshots.map(({ snapshot }) => hashScreenshot(buildTerminalVisualHashInput(snapshot)))
          );
          const hash =
            componentHashes.length === 1
              ? componentHashes[0]
              : await hashScreenshot(buildCompoundScreenshotHashInput(componentHashes));
          if (isDisposed) {
            return;
          }

          const latestStore = useTerminalStore.getState();
          const latestSessions = statusTerminalIds
            .map((terminalId) => latestStore.sessions[terminalId])
            .filter((session): session is NonNullable<typeof session> => session !== undefined);
          if (latestSessions.length !== statusTerminalIds.length) {
            continue;
          }

          const previousHash = previousHashes.get(tabRootTerminalId) ?? null;
          const previousComponentSnapshots = previousComponents.get(tabRootTerminalId) ?? [];
          const recentTabHashes = recentHashes.get(tabRootTerminalId) ?? [];
          const tabSignature = terminalIds.join("|");
          const previousTabSignature = previousTabSignatures.get(tabRootTerminalId) ?? null;
          const isBaselineCapture =
            previousHash === null || previousTabSignature !== tabSignature;
          const visualChange = summarizeTerminalVisualChange({
            previousComponents: isBaselineCapture ? [] : previousComponentSnapshots,
            currentComponents: screenshots.map(({ snapshot }) => snapshot),
            previousHash: isBaselineCapture ? null : previousHash,
            currentHash: hash,
            recentHashes: isBaselineCapture ? [] : recentTabHashes,
          });
          const changed = !isBaselineCapture && visualChange.changed;
          const lastUserInputAt = latestSessions.reduce(
            (maxTime, session) => Math.max(maxTime, session.lastUserInputAt ?? 0),
            0
          );
          const lastOutputAt = latestSessions.reduce(
            (maxTime, session) => Math.max(maxTime, session.lastOutputAt ?? 0),
            0
          );
          const focusVisualSuppression = focusVisualSuppressions.get(tabRootTerminalId) ?? null;
          if (focusVisualSuppression && now > focusVisualSuppression.until) {
            focusVisualSuppressions.delete(tabRootTerminalId);
          }
          const activeFocusVisualSuppression =
            focusVisualSuppression && now <= focusVisualSuppression.until
              ? focusVisualSuppression
              : null;
          const ignoreTmuxFocusVisualChange = shouldIgnoreTmuxFocusVisualChange({
            changed,
            hasActiveFocusVisualSuppression: activeFocusVisualSuppression !== null,
            hasTmuxStatusSession: latestSessions.some(isTmuxStatusSession),
            lastUserInputAt,
            lastOutputAt,
            suppressionStartedAt: activeFocusVisualSuppression?.startedAt ?? 0,
          });
          const activeResizeSuppression = getActiveStatusResizeSuppression(
            [...terminalIds, ...statusTerminalIds],
            now
          );
          const ignoreResizeVisualChange = shouldIgnoreStatusResizeChange({
            changed,
            suppression: activeResizeSuppression,
            lastUserInputAt,
            lastOutputAt,
          });
          const ignoreVisualChange = ignoreTmuxFocusVisualChange || ignoreResizeVisualChange;
          const visualChangeIgnoredReason = ignoreVisualChange
            ? ignoreResizeVisualChange
              ? "resize"
              : "tmux-focus-refresh"
            : undefined;
          const changedForStatus = changed && !ignoreVisualChange;
          const changedAt =
            changedForStatus || isBaselineCapture
              ? now
              : (lastChangedAt.get(tabRootTerminalId) ?? now);
          const effectiveChangedAt = Math.max(changedAt, lastUserInputAt, lastOutputAt);
          const hasDetectedActivity =
            latestSessions.some((session) => session.hasDetectedActivity)
            || lastUserInputAt > 0
            || lastOutputAt > 0;
          const acknowledgedTime = acknowledgedAt.get(tabRootTerminalId) ?? 0;
          const isActiveTab = activeTabRootTerminalId === tabRootTerminalId;
          const {
            hasAcknowledgedCurrentOutput,
            idleStartedAt,
            staleStartedAt,
            brownStartedAt,
            changedForStatus: resolvedChangedForStatus,
            shouldKeepAttentionUntilFocus,
            shouldKeepBrownUntilInput,
            nextNeedsAttention,
            nextPossiblyDone,
            nextLongInactive,
          } = resolveTerminalScreenshotStatus({
            hasDetectedActivity,
            isActiveTab,
            changed,
            ignoreVisualChange,
            now,
            effectiveChangedAt,
            acknowledgedTime,
            wasNeedsAttention: latestSessions.some((session) => session.isNeedsAttention),
            wasPossiblyDone: latestSessions.some((session) => session.isPossiblyDone),
            inactivityMs: SCREENSHOT_INACTIVITY_MS,
            longInactivityMs: SCREENSHOT_LONG_INACTIVITY_MS,
          });
          const statusDotSemantic = getStatusDotSemantic({
            hasDetectedActivity,
            nextNeedsAttention,
            nextPossiblyDone,
            nextLongInactive,
          });
          const nextStatusSnapshot = [
            hasDetectedActivity ? "activity" : "idle",
            isActiveTab ? "active" : "background",
            resolvedChangedForStatus ? "changed" : "stable",
            hasAcknowledgedCurrentOutput ? "ack" : "unack",
            nextNeedsAttention ? "attention" : "no-attention",
            nextPossiblyDone ? "done" : "not-done",
            nextLongInactive ? "long-idle" : "not-long-idle",
          ].join("|");
          const previousStatusSnapshot = previousStatusSnapshots.get(tabRootTerminalId) ?? null;
          const statusTransitioned = previousStatusSnapshot !== nextStatusSnapshot;
          const statusDebugDetails = {
            tabRootTerminalId,
            previousStatusSnapshot,
            nextStatusSnapshot,
            activeTabRootTerminalId,
            terminalIds,
            statusTerminalIds,
            statusDotSemantic,
            changed,
            changedForStatus: resolvedChangedForStatus,
            ignoreVisualChange,
            visualChangeIgnoredReason,
            focusVisualSuppressionUntil: activeFocusVisualSuppression?.until ?? null,
            resizeSuppressionUntil: activeResizeSuppression?.until ?? null,
            resizeSuppressionReason: activeResizeSuppression?.reason ?? null,
            resizeSuppressionTerminalId: activeResizeSuppression?.terminalId ?? null,
            hasDetectedActivity,
            isActiveTab,
            lastUserInputAt,
            lastOutputAt,
            effectiveChangedAt,
            acknowledgedTime,
            idleStartedAt,
            staleStartedAt,
            brownStartedAt,
            exactChanged: visualChange.exactChanged,
            repeatingHashOscillation: visualChange.repeatingHashOscillation,
            hasThreeSamples: visualChange.hasThreeSamples,
            changedRows: visualChange.changedRows,
            changedChars: visualChange.changedChars,
            changedRowRatio: visualChange.changedRowRatio,
            changedCharRatio: visualChange.changedCharRatio,
            nextNeedsAttention,
            nextPossiblyDone,
            nextLongInactive,
            shouldKeepAttentionUntilFocus,
            shouldKeepBrownUntilInput,
            visualSampled: true,
            timestampOnlyStatus: false,
            backendKinds: [...new Set(latestSessions.map((session) => session.backendKind))],
          };
          if (ignoreVisualChange) {
            debugLog("status.monitor", "ignored focus-only visual change", statusDebugDetails);
            pushStatusDebug({
              terminalId: tabRootTerminalId,
              event: "visual-change-ignored",
              reason: visualChangeIgnoredReason,
              ...statusDebugDetails,
            });
          }
          if (statusTransitioned) {
            previousStatusSnapshots.set(tabRootTerminalId, nextStatusSnapshot);
            debugLog("status.monitor", "state transition", statusDebugDetails);
            pushStatusDebug({
              terminalId: tabRootTerminalId,
              event: "transition",
              ...statusDebugDetails,
            });
          }

          const lastArtifactTime = lastArtifactAt.get(tabRootTerminalId) ?? 0;
          const shouldWriteScreenshotArtifact = shouldWriteScreenshotDebugArtifact({
            isBaselineCapture,
            statusTransitioned,
            now,
            lastTabArtifactAt: lastArtifactTime,
            lastGlobalArtifactAt,
          });
          const shouldAttachScreenshotImages = shouldWriteScreenshotArtifact;
          const screenshotsWithOptionalImages = shouldAttachScreenshotImages
            ? attachScreenshotImages(screenshots, { maxImages: MAX_SCREENSHOT_IMAGE_CAPTURES_PER_SAMPLE })
            : screenshots;
          if (shouldWriteScreenshotArtifact) {
            lastArtifactAt.set(tabRootTerminalId, now);
            lastGlobalArtifactAt = now;
            void writeScreenshotDebugArtifacts({
              now,
              tabRootTerminalId,
              activeTabRootTerminalId,
              terminalIds,
              statusTerminalIds,
              screenshots: screenshotsWithOptionalImages,
              componentHashes,
              hash,
              previousHash,
              visualChange,
              changed,
              changedForStatus: resolvedChangedForStatus,
              ignoreVisualChange,
              visualChangeIgnoredReason,
              hasDetectedActivity,
              isActiveTab,
              lastUserInputAt,
              lastOutputAt,
              effectiveChangedAt,
              acknowledgedTime,
              idleStartedAt,
              staleStartedAt,
              brownStartedAt,
              nextNeedsAttention,
              nextPossiblyDone,
              nextLongInactive,
              shouldKeepAttentionUntilFocus,
              shouldKeepBrownUntilInput,
              sessions: latestSessions,
              previousStatusSnapshot,
              nextStatusSnapshot,
            }).catch((error) => {
              debugLog("status.monitor", "failed to write screenshot artifacts; inlining first screenshot", {
                error: error instanceof Error ? error.message : String(error),
                tabRootTerminalId,
                statusDotSemantic,
                nextStatusSnapshot,
                terminalIds,
                statusTerminalIds,
                hash,
                previousHash,
                changed,
                changedForStatus: resolvedChangedForStatus,
                ignoreVisualChange,
                visualChangeIgnoredReason: visualChangeIgnoredReason ?? null,
                exactChanged: visualChange.exactChanged,
                repeatingHashOscillation: visualChange.repeatingHashOscillation,
                changedRows: visualChange.changedRows,
                changedChars: visualChange.changedChars,
                firstComponentTerminalId: screenshots[0]?.terminalId ?? null,
                firstComponentImageDataUrl: screenshots[0]?.screenshot ?? null,
              });
            });
          }

          previousHashes.set(tabRootTerminalId, hash);
          previousComponents.set(
            tabRootTerminalId,
            screenshots.map(({ snapshot }) => snapshot)
          );
          recentHashes.set(tabRootTerminalId, [...recentTabHashes, hash].slice(-2));
          previousTabSignatures.set(tabRootTerminalId, tabSignature);
          lastChangedAt.set(tabRootTerminalId, changedAt);
          for (const terminalId of statusTerminalIds) {
            store.setDetectedActivity(terminalId, hasDetectedActivity);
            store.setNeedsAttention(terminalId, nextNeedsAttention);
            store.setPossiblyDone(terminalId, nextPossiblyDone);
            store.setLongInactive(terminalId, nextLongInactive);
          }
          pushScreenshotDebug({
            terminalId: tabRootTerminalId,
            hash,
            previousHash,
            imageDataUrl: screenshotsWithOptionalImages.length === 1
              ? screenshotsWithOptionalImages[0].screenshot
              : undefined,
            changed,
            changedForStatus: resolvedChangedForStatus,
            ignoreVisualChange,
            visualChangeIgnoredReason,
            exactChanged: visualChange.exactChanged,
            repeatingHashOscillation: visualChange.repeatingHashOscillation,
            hasThreeSamples: visualChange.hasThreeSamples,
            changedRows: visualChange.changedRows,
            changedChars: visualChange.changedChars,
            changedRowRatio: visualChange.changedRowRatio,
            changedCharRatio: visualChange.changedCharRatio,
            hasDetectedActivity,
            isNeedsAttention: nextNeedsAttention,
            isPossiblyDone: nextPossiblyDone,
            isLongInactive: nextLongInactive,
            componentTerminalIds: terminalIds,
            componentHashes,
            componentImageDataUrls: getCompleteComponentImageDataUrls(screenshotsWithOptionalImages),
          });
        }
      } finally {
        isSampling = false;
      }
    };

    const sampleAllTabs = async () => {
      const store = useTerminalStore.getState();
      const layouts = useLayoutStore.getState().layouts;
      const sessionIds = new Set(Object.keys(store.sessions));
      const activeTabRootTerminalId = getActiveTabRootTerminalId();
      const tabRootTerminalIds = getTabRootTerminalIds(layouts, sessionIds);

      for (const tabRootTerminalId of tabRootTerminalIds) {
        applyTimestampStatus({
          tabRootTerminalId,
          now: Date.now(),
          layouts,
          sessionIds,
          activeTabRootTerminalId,
          reason: "interval",
        });
      }

      for (const tabRootTerminalId of tabRootTerminalIds) {
        const statusTerminalIds = getTabStatusTerminalIds(layouts, tabRootTerminalId, sessionIds);
        const statusSessions = statusTerminalIds
          .map((terminalId) => store.sessions[terminalId])
          .filter((session): session is TerminalSession => session !== undefined);
        if (statusSessions.length > 0 && shouldUseTimestampOnlyStatus(statusSessions)) {
          previousHashes.delete(tabRootTerminalId);
          previousComponents.delete(tabRootTerminalId);
          recentHashes.delete(tabRootTerminalId);
          previousTabSignatures.delete(tabRootTerminalId);
        }
      }

      const selection = selectVisualSampleTabRootTerminalIds({
        tabRootTerminalIds,
        activeTabRootTerminalId,
        maxTabs: MAX_VISUAL_TABS_PER_SAMPLE,
        cursor: visualSampleCursor,
        canSample: (tabRootTerminalId) => {
          const terminalIds = getTabTerminalIds(layouts, tabRootTerminalId, sessionIds);
          const statusTerminalIds = getTabStatusTerminalIds(layouts, tabRootTerminalId, sessionIds);
          const statusSessions = statusTerminalIds
            .map((terminalId) => store.sessions[terminalId])
            .filter((session): session is TerminalSession => session !== undefined);
          return (
            terminalIds.length > 0
            && terminalIds.every((terminalId) => hasTerminalFrontend(terminalId))
            && !shouldUseTimestampOnlyStatus(statusSessions)
          );
        },
      });
      visualSampleCursor = selection.nextCursor;
      await sampleTabs(selection.selected);
    };

    const scheduleSample = (delayMs: number) => {
      const timeoutId = window.setTimeout(() => {
        scheduledSamples.delete(timeoutId);
        void sampleAllTabs();
      }, delayMs);
      scheduledSamples.add(timeoutId);
    };

    void sampleAllTabs();
    scheduleSample(500);
    scheduleSample(1500);
    acknowledgeTab(
      getActiveTabRootTerminalId(),
      new Set(Object.keys(useTerminalStore.getState().sessions)),
      Date.now(),
      "startup-active-tab"
    );

    let lastSessionSignature = Object.keys(useTerminalStore.getState().sessions).sort().join("|");
    const unsubscribeSessions = useTerminalStore.subscribe((state) => {
      const nextSignature = Object.keys(state.sessions).sort().join("|");
      if (nextSignature === lastSessionSignature) {
        return;
      }

      lastSessionSignature = nextSignature;
      scheduleSample(0);
      scheduleSample(500);
    });
    const unsubscribeActiveTerminal = useTerminalStore.subscribe((state, previousState) => {
      if (state.activeTerminalId === previousState.activeTerminalId) {
        return;
      }

      const now = Date.now();
      acknowledgeTab(
        getActiveTabRootTerminalId(),
        new Set(Object.keys(state.sessions)),
        now,
        "active-terminal-changed"
      );
    });

    const intervalId = window.setInterval(() => {
      void sampleAllTabs();
    }, SCREENSHOT_INTERVAL_MS);

    return () => {
      isDisposed = true;
      unsubscribeSessions();
      unsubscribeActiveTerminal();
      window.clearInterval(intervalId);
      for (const timeoutId of scheduledSamples) {
        window.clearTimeout(timeoutId);
      }
      scheduledSamples.clear();
    };
  }, []);
}
