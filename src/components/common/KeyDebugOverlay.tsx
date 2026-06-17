import { useEffect, useMemo, useRef, useState } from "react";
import {
  clearKeyDebugEntries,
  getCurrentKeyDebugGeneration,
  getKeyDebugEntries,
  subscribeKeyDebug,
  type KeyDebugEntry,
} from "../../lib/keyDebug";
import {
  clearScreenshotDebugEntries,
  getCurrentScreenshotDebugGeneration,
  getScreenshotDebugEntries,
  subscribeScreenshotDebug,
  type ScreenshotDebugEntry,
} from "../../lib/screenshotDebug";
import {
  clearStatusDebugEntries,
  getCurrentStatusDebugGeneration,
  getStatusDebugEntries,
  subscribeStatusDebug,
  type StatusDebugEntry,
} from "../../lib/statusDebug";
import { findLayoutKeyForTerminal } from "../../lib/layoutUtils";
import { getScopedStorageKey } from "../../lib/storageNamespace";
import { useLayoutStore } from "../../stores/useLayoutStore";
import { useTerminalStore } from "../../stores/useTerminalStore";

const KEY_DEBUG_WIDTH_STORAGE_KEY = getScopedStorageKey("dispatcher.keydebug.width");
type DebugTab = "status" | "keys" | "screenshots";

function readStoredWidth(): number {
  if (typeof window === "undefined") return 640;
  const raw = window.localStorage.getItem(KEY_DEBUG_WIDTH_STORAGE_KEY);
  const value = raw ? Number(raw) : NaN;
  return Number.isFinite(value) ? value : 640;
}

function formatTime(entry: KeyDebugEntry): string {
  return `${entry.timestamp}.${String(entry.timestampMs % 1000).padStart(3, "0")}`;
}

function formatScreenshotComponents(entry: ScreenshotDebugEntry): string | null {
  if (!entry.componentTerminalIds || !entry.componentHashes) {
    return null;
  }

  return entry.componentTerminalIds
    .map((terminalId, index) => `${terminalId}:${entry.componentHashes?.[index] ?? "missing"}`)
    .join(", ");
}

function formatScreenshotChangeMetrics(entry: ScreenshotDebugEntry): string {
  const rowRatio = entry.changedRowRatio !== undefined
    ? ` rowRatio=${entry.changedRowRatio.toFixed(3)}`
    : "";
  const charRatio = entry.changedCharRatio !== undefined
    ? ` charRatio=${entry.changedCharRatio.toFixed(3)}`
    : "";
  return [
    `changed=${String(entry.changed)}`,
    entry.changedForStatus !== undefined ? `statusChanged=${String(entry.changedForStatus)}` : null,
    entry.ignoreVisualChange ? `ignored=${entry.visualChangeIgnoredReason ?? "true"}` : null,
    `exact=${String(entry.exactChanged ?? entry.changed)}`,
    `repeat=${String(entry.repeatingHashOscillation ?? false)}`,
    `three=${String(entry.hasThreeSamples ?? false)}`,
    `rows=${entry.changedRows ?? "?"}`,
    `chars=${entry.changedChars ?? "?"}`,
    `${rowRatio}${charRatio}`.trim(),
  ].filter((part): part is string => part !== null && part !== "").join(" ");
}

function formatStatusEvent(entry: StatusDebugEntry): string {
  if (entry.event === "visual-change-ignored") {
    return "ignored";
  }
  if (entry.event === "acknowledge") {
    return "ack";
  }
  return entry.statusDotSemantic ?? "transition";
}

function formatMaybeTime(value: number | undefined | null): string | null {
  if (!value) {
    return null;
  }
  return new Date(value).toLocaleTimeString();
}

function formatStatusDetail(entry: StatusDebugEntry): string {
  const focusSuppressionUntil = formatMaybeTime(entry.focusVisualSuppressionUntil);
  const resizeSuppressionUntil = formatMaybeTime(entry.resizeSuppressionUntil);
  const timing = [
    entry.acknowledgedTime ? `ack=${formatMaybeTime(entry.acknowledgedTime)}` : null,
    entry.effectiveChangedAt ? `effective=${formatMaybeTime(entry.effectiveChangedAt)}` : null,
    entry.staleStartedAt ? `stale=${formatMaybeTime(entry.staleStartedAt)}` : null,
    entry.brownStartedAt ? `brown=${formatMaybeTime(entry.brownStartedAt)}` : null,
    entry.lastUserInputAt ? `input=${formatMaybeTime(entry.lastUserInputAt)}` : null,
    entry.lastOutputAt ? `output=${formatMaybeTime(entry.lastOutputAt)}` : null,
    focusSuppressionUntil ? `focusSuppressUntil=${focusSuppressionUntil}` : null,
    resizeSuppressionUntil ? `resizeSuppressUntil=${resizeSuppressionUntil}` : null,
  ].filter((part): part is string => part !== null).join(" ");
  const change = [
    entry.changed !== undefined ? `changed=${String(entry.changed)}` : null,
    entry.changedForStatus !== undefined ? `statusChanged=${String(entry.changedForStatus)}` : null,
    entry.timestampOnlyStatus ? "timestampOnly=true" : null,
    entry.ignoreVisualChange ? `ignored=${entry.visualChangeIgnoredReason ?? "true"}` : null,
    entry.changedRows !== undefined ? `rows=${entry.changedRows}` : null,
    entry.changedChars !== undefined ? `chars=${entry.changedChars}` : null,
  ].filter((part): part is string => part !== null).join(" ");
  const next = [
    entry.nextNeedsAttention !== undefined ? `attention=${String(entry.nextNeedsAttention)}` : null,
    entry.nextPossiblyDone !== undefined ? `done=${String(entry.nextPossiblyDone)}` : null,
    entry.nextLongInactive !== undefined ? `longIdle=${String(entry.nextLongInactive)}` : null,
    entry.shouldKeepBrownUntilInput ? "keptBrownUntilInput=true" : null,
    entry.shouldKeepAttentionUntilFocus ? "keptAttentionUntilFocus=true" : null,
  ].filter((part): part is string => part !== null).join(" ");

  return [
    `terminal=${entry.terminalId}`,
    entry.reason ? `reason=${entry.reason}` : null,
    entry.previousStatusSnapshot !== undefined
      ? `from=${entry.previousStatusSnapshot ?? "none"}`
      : null,
    entry.nextStatusSnapshot ? `to=${entry.nextStatusSnapshot}` : null,
    entry.statusTerminalIds?.length ? `statusTerminals=${entry.statusTerminalIds.join(", ")}` : null,
    entry.backendKinds?.length ? `backends=${entry.backendKinds.join(", ")}` : null,
    timing || null,
    change || null,
    next || null,
  ].filter((line): line is string => line !== null).join("\n");
}

function getScreenshotImageItems(
  entry: ScreenshotDebugEntry,
  sessions: Record<string, { title: string } | undefined>
): Array<{ terminalId: string; label: string; imageDataUrl: string }> {
  const componentTerminalIds = entry.componentTerminalIds;
  const componentImageDataUrls = entry.componentImageDataUrls;

  if (
    componentTerminalIds &&
    componentImageDataUrls &&
    componentTerminalIds.length === componentImageDataUrls.length
  ) {
    return componentTerminalIds.map((terminalId, index) => ({
      terminalId,
      label: sessions[terminalId]?.title ?? terminalId,
      imageDataUrl: componentImageDataUrls[index],
    }));
  }

  return entry.imageDataUrl
    ? [
        {
          terminalId: entry.terminalId,
          label: sessions[entry.terminalId]?.title ?? entry.terminalId,
          imageDataUrl: entry.imageDataUrl,
        },
      ]
    : [];
}

export function KeyDebugOverlay() {
  const [entries, setEntries] = useState<KeyDebugEntry[]>(() => getKeyDebugEntries());
  const [screenshotEntries, setScreenshotEntries] = useState<ScreenshotDebugEntry[]>(() => getScreenshotDebugEntries());
  const [statusEntries, setStatusEntries] = useState<StatusDebugEntry[]>(() => getStatusDebugEntries());
  const [generation, setGeneration] = useState(() => getCurrentKeyDebugGeneration());
  const [screenshotGeneration, setScreenshotGeneration] = useState(() => getCurrentScreenshotDebugGeneration());
  const [statusGeneration, setStatusGeneration] = useState(() => getCurrentStatusDebugGeneration());
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [width, setWidth] = useState(() => readStoredWidth());
  const [activeTab, setActiveTab] = useState<DebugTab>("status");
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const sessions = useTerminalStore((state) => state.sessions);
  const activeTerminalId = useTerminalStore((state) => state.activeTerminalId);
  const layouts = useLayoutStore((state) => state.layouts);

  useEffect(() => subscribeKeyDebug(setEntries), []);
  useEffect(() => subscribeScreenshotDebug(setScreenshotEntries), []);
  useEffect(() => subscribeStatusDebug(setStatusEntries), []);
  useEffect(() => {
    window.localStorage.setItem(KEY_DEBUG_WIDTH_STORAGE_KEY, String(width));
  }, [width]);

  const visibleEntries = useMemo(
    () => [...entries].filter((entry) => entry.generation === generation).reverse().slice(0, 18),
    [entries, generation]
  );
  const activeTabTerminalId = useMemo(
    () => activeTerminalId
      ? findLayoutKeyForTerminal(layouts, activeTerminalId) ?? activeTerminalId
      : null,
    [activeTerminalId, layouts]
  );
  const visibleStatusEntries = useMemo(
    () => {
      if (!activeTabTerminalId) {
        return [];
      }

      return [...statusEntries]
        .filter((entry) => entry.generation === statusGeneration && entry.terminalId === activeTabTerminalId)
        .reverse()
        .slice(0, 24);
    },
    [activeTabTerminalId, statusEntries, statusGeneration]
  );
  const visibleScreenshotEntries = useMemo(
    () => {
      if (!activeTabTerminalId) {
        return [];
      }

      return [...screenshotEntries]
        .filter((entry) => entry.generation === screenshotGeneration && entry.terminalId === activeTabTerminalId)
        .reverse()
        .slice(0, 18);
    },
    [activeTabTerminalId, screenshotEntries, screenshotGeneration]
  );

  const handleClear = () => {
    if (activeTab === "keys") {
      setGeneration(clearKeyDebugEntries());
      setEntries([]);
    } else if (activeTab === "screenshots") {
      setScreenshotGeneration(clearScreenshotDebugEntries());
      setScreenshotEntries([]);
    } else {
      setStatusGeneration(clearStatusDebugEntries());
      setStatusEntries([]);
    }
    setCopyState("idle");
  };

  const handleCopy = async () => {
    const text = (() => {
      if (activeTab === "keys") {
        return [
          `Key Debug G${generation}`,
          ...visibleEntries.map((entry) => `${formatTime(entry)}\n${entry.source}\n${entry.detail}`),
        ].join("\n");
      }

      if (activeTab === "screenshots") {
        return [
          `Screenshot Debug G${screenshotGeneration}`,
          `terminal=${activeTabTerminalId ?? "none"}`,
          ...visibleScreenshotEntries.map((entry) => [
            `${entry.timestamp}.${String(entry.timestampMs % 1000).padStart(3, "0")}`,
            `${sessions[entry.terminalId]?.title ?? entry.terminalId} (${entry.terminalId})`,
            `hash=${entry.hash}`,
            `prev=${entry.previousHash ?? "none"}`,
            formatScreenshotComponents(entry)
              ? `components=${formatScreenshotComponents(entry)}`
              : null,
            formatScreenshotChangeMetrics(entry),
            `detected=${String(entry.hasDetectedActivity)} attention=${String(entry.isNeedsAttention)} done=${String(entry.isPossiblyDone)} longInactive=${String(entry.isLongInactive)}`,
          ].filter((line): line is string => line !== null).join("\n")),
        ].join("\n");
      }

      return [
        `Status Debug G${statusGeneration}`,
        `terminal=${activeTabTerminalId ?? "none"}`,
        ...visibleStatusEntries.map((entry) => [
          `${entry.timestamp}.${String(entry.timestampMs % 1000).padStart(3, "0")}`,
          `${sessions[entry.terminalId]?.title ?? entry.terminalId} (${entry.terminalId})`,
          formatStatusEvent(entry),
          formatStatusDetail(entry),
        ].join("\n")),
      ].join("\n");
    })();

    try {
      await navigator.clipboard.writeText(text);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  const handleResizeMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    resizeRef.current = { startX: e.clientX, startWidth: width };

    const onMouseMove = (moveEvent: MouseEvent) => {
      const state = resizeRef.current;
      if (!state) return;
      const nextWidth = Math.max(360, Math.min(window.innerWidth - 24, state.startWidth + (state.startX - moveEvent.clientX)));
      setWidth(nextWidth);
    };

    const onMouseUp = () => {
      resizeRef.current = null;
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
  };

  return (
    <div className="key-debug-overlay" style={{ width: `${width}px` }}>
      <div className="key-debug-resize-handle" onMouseDown={handleResizeMouseDown} />
      <div className="key-debug-header">
        <strong>
          {activeTab === "keys"
            ? `Key Debug G${generation}`
            : activeTab === "screenshots"
              ? `Screenshot Debug G${screenshotGeneration}`
              : `Status Debug G${statusGeneration}`}
        </strong>
        <div className="key-debug-actions">
          <button type="button" onClick={handleCopy}>
            {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy"}
          </button>
          <button type="button" onClick={handleClear}>Clear</button>
        </div>
      </div>
      <div className="key-debug-tabs">
        <button
          type="button"
          className={`key-debug-tab ${activeTab === "status" ? "active" : ""}`}
          onClick={() => {
            setActiveTab("status");
            setCopyState("idle");
          }}
        >
          Status
        </button>
        <button
          type="button"
          className={`key-debug-tab ${activeTab === "keys" ? "active" : ""}`}
          onClick={() => {
            setActiveTab("keys");
            setCopyState("idle");
          }}
        >
          Keys
        </button>
        <button
          type="button"
          className={`key-debug-tab ${activeTab === "screenshots" ? "active" : ""}`}
          onClick={() => {
            setActiveTab("screenshots");
            setCopyState("idle");
          }}
        >
          Screenshots
        </button>
      </div>
      <div className="key-debug-list">
        {activeTab === "keys" ? (
          visibleEntries.length === 0 ? (
            <div className="key-debug-empty">No events yet</div>
          ) : (
            visibleEntries.map((entry) => (
              <div key={entry.id} className="key-debug-entry">
                <span className="key-debug-time">{formatTime(entry)}</span>
                <span className="key-debug-source">{entry.source}</span>
                <span className="key-debug-detail">{entry.detail}</span>
              </div>
            ))
          )
        ) : activeTab === "status" ? (
          visibleStatusEntries.length === 0 ? (
            <div className="key-debug-empty">No status changes yet for the active tab</div>
          ) : (
            visibleStatusEntries.map((entry) => (
              <div key={entry.id} className="key-debug-entry key-debug-entry-status">
                <span className="key-debug-time">{`${entry.timestamp}.${String(entry.timestampMs % 1000).padStart(3, "0")}`}</span>
                <span className="key-debug-source">{formatStatusEvent(entry)}</span>
                <span className="key-debug-detail">{formatStatusDetail(entry)}</span>
              </div>
            ))
          )
        ) : visibleScreenshotEntries.length === 0 ? (
          <div className="key-debug-empty">No screenshots yet for the active tab</div>
        ) : (
          visibleScreenshotEntries.map((entry) => {
            const screenshotImageItems = getScreenshotImageItems(entry, sessions);
            return (
              <div key={entry.id} className="key-debug-entry key-debug-entry-screenshot">
                <span className="key-debug-time">{`${entry.timestamp}.${String(entry.timestampMs % 1000).padStart(3, "0")}`}</span>
                <span className="key-debug-source">{sessions[entry.terminalId]?.title ?? entry.terminalId}</span>
                <span className="key-debug-detail">
                  {[
                    `terminal=${entry.terminalId}`,
                    `hash=${entry.hash}`,
                    `prev=${entry.previousHash ?? "none"}`,
                    formatScreenshotComponents(entry)
                      ? `components=${formatScreenshotComponents(entry)}`
                      : null,
                    formatScreenshotChangeMetrics(entry),
                    `detected=${String(entry.hasDetectedActivity)}`,
                    `attention=${String(entry.isNeedsAttention)}`,
                    `done=${String(entry.isPossiblyDone)}`,
                    `longInactive=${String(entry.isLongInactive)}`,
                  ].filter((line): line is string => line !== null).join("\n")}
                </span>
                {screenshotImageItems.length > 0 ? (
                  <div className="key-debug-screenshot-gallery">
                    {screenshotImageItems.map((item) => (
                      <figure key={`${entry.id}-${item.terminalId}`} className="key-debug-screenshot-card">
                        <figcaption className="key-debug-screenshot-caption">
                          {item.label}
                        </figcaption>
                        <img
                          className="key-debug-screenshot-image"
                          src={item.imageDataUrl}
                          alt={`Terminal screenshot for ${item.label}`}
                        />
                      </figure>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
