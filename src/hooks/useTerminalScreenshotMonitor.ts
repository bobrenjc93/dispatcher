import { useEffect } from "react";
import { captureTerminalScreenshot, ensureTerminalScreenshotTarget } from "./useTerminalBridge";
import { findLayoutKeyForTerminal, findTerminalIds } from "../lib/layoutUtils";
import { pushScreenshotDebug } from "../lib/screenshotDebug";
import { useLayoutStore } from "../stores/useLayoutStore";
import { useTerminalStore } from "../stores/useTerminalStore";

const SCREENSHOT_INTERVAL_MS = 5_000;
const SCREENSHOT_INACTIVITY_MS = 10_000;
const SCREENSHOT_LONG_INACTIVITY_MS = 60 * 60 * 1000;

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

function getTabTerminalIds(
  tabRootTerminalId: string | null,
  sessionIds: Set<string>
): string[] {
  if (!tabRootTerminalId) {
    return [];
  }

  const layout = useLayoutStore.getState().layouts[tabRootTerminalId];
  if (!layout) {
    return sessionIds.has(tabRootTerminalId) ? [tabRootTerminalId] : [];
  }

  return findTerminalIds(layout).filter((terminalId) => sessionIds.has(terminalId));
}

export function useTerminalScreenshotMonitor() {
  useEffect(() => {
    const previousHashes = new Map<string, string>();
    const lastChangedAt = new Map<string, number>();
    const acknowledgedAt = new Map<string, number>();
    const scheduledSamples = new Set<number>();
    let isSampling = false;
    let isDisposed = false;

    const acknowledgeTab = (
      tabRootTerminalId: string | null,
      sessionIds: Set<string>,
      now: number
    ) => {
      if (!tabRootTerminalId) {
        return;
      }

      const store = useTerminalStore.getState();
      for (const terminalId of getTabTerminalIds(tabRootTerminalId, sessionIds)) {
        const session = store.sessions[terminalId];
        acknowledgedAt.set(terminalId, now);
        if (session?.isNeedsAttention) {
          store.setNeedsAttention(terminalId, false);
          store.setPossiblyDone(terminalId, true);
        }
      }
    };

    const sampleTerminals = async (terminalIds: string[]) => {
      if (isSampling || isDisposed) {
        return;
      }

      isSampling = true;
      const now = Date.now();
      try {
        const store = useTerminalStore.getState();
        const activeTabTerminalIds = new Set(
          getTabTerminalIds(
            getActiveTabRootTerminalId(),
            new Set(Object.keys(store.sessions))
          )
        );
        const activeIds = new Set(Object.keys(store.sessions));

        for (const terminalId of previousHashes.keys()) {
          if (!activeIds.has(terminalId)) {
            previousHashes.delete(terminalId);
            lastChangedAt.delete(terminalId);
            acknowledgedAt.delete(terminalId);
          }
        }

        for (const terminalId of terminalIds) {
          const session = store.sessions[terminalId];
          ensureTerminalScreenshotTarget(terminalId, session?.cwd);
          const screenshot = captureTerminalScreenshot(terminalId);
          if (screenshot === null) {
            continue;
          }

          const hash = await hashScreenshot(screenshot);
          if (isDisposed) {
            return;
          }

          const previousHash = previousHashes.get(terminalId) ?? null;
          const isBaselineCapture = previousHash === null;
          const changed = !isBaselineCapture && previousHash !== hash;
          const changedAt = changed ? now : (lastChangedAt.get(terminalId) ?? now);
          const lastUserInputAt = session?.lastUserInputAt ?? 0;
          const effectiveChangedAt = Math.max(changedAt, lastUserInputAt);
          const hasDetectedActivity =
            (session?.hasDetectedActivity ?? false) || lastUserInputAt > 0;
          const acknowledgedTime = acknowledgedAt.get(terminalId) ?? 0;
          const hasAcknowledgedCurrentOutput =
            hasDetectedActivity && acknowledgedTime >= effectiveChangedAt;
          const idleStartedAt = hasAcknowledgedCurrentOutput
            ? Math.max(effectiveChangedAt, acknowledgedTime)
            : effectiveChangedAt;
          const isActiveTabTerminal = activeTabTerminalIds.has(terminalId);
          if (changed && isActiveTabTerminal) {
            acknowledgedAt.set(terminalId, now);
          }
          const isNeedsAttention =
            hasDetectedActivity &&
            !changed &&
            !hasAcknowledgedCurrentOutput &&
            now - effectiveChangedAt >= SCREENSHOT_INACTIVITY_MS;
          const isLongInactive =
            hasDetectedActivity &&
            !changed &&
            now - idleStartedAt >= SCREENSHOT_LONG_INACTIVITY_MS;
          const isPossiblyDone =
            hasDetectedActivity &&
            !changed &&
            !isNeedsAttention &&
            hasAcknowledgedCurrentOutput &&
            !isLongInactive &&
            now - idleStartedAt >= SCREENSHOT_INACTIVITY_MS;
          const shouldKeepBrownUntilInput =
            (session?.isPossiblyDone ?? false) &&
            lastUserInputAt <= acknowledgedTime;
          const shouldRevertToGreen = changed && !(session?.isNeedsAttention ?? false);
          const nextNeedsAttention = shouldRevertToGreen
            ? false
            : shouldKeepBrownUntilInput
              ? false
              : (isNeedsAttention && !isLongInactive);
          const nextPossiblyDone = shouldRevertToGreen
            ? false
            : shouldKeepBrownUntilInput
              ? !isLongInactive
              : isPossiblyDone;
          const nextLongInactive = nextNeedsAttention ? false : isLongInactive;

          previousHashes.set(terminalId, hash);
          lastChangedAt.set(terminalId, changedAt);
          store.setNeedsAttention(terminalId, nextNeedsAttention);
          store.setPossiblyDone(terminalId, nextPossiblyDone);
          store.setLongInactive(terminalId, nextLongInactive);
          pushScreenshotDebug({
            terminalId,
            hash,
            previousHash,
            changed,
            hasDetectedActivity,
            isNeedsAttention: nextNeedsAttention,
            isPossiblyDone: nextPossiblyDone,
            isLongInactive: nextLongInactive,
            imageDataUrl: screenshot,
          });
        }
      } finally {
        isSampling = false;
      }
    };

    const sampleAllTerminals = async () => {
      const terminalIds = Object.keys(useTerminalStore.getState().sessions);
      await sampleTerminals(terminalIds);
    };

    const scheduleSample = (delayMs: number) => {
      const timeoutId = window.setTimeout(() => {
        scheduledSamples.delete(timeoutId);
        void sampleAllTerminals();
      }, delayMs);
      scheduledSamples.add(timeoutId);
    };

    void sampleAllTerminals();
    scheduleSample(500);
    scheduleSample(1500);
    acknowledgeTab(getActiveTabRootTerminalId(), new Set(Object.keys(useTerminalStore.getState().sessions)), Date.now());

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
      acknowledgeTab(getActiveTabRootTerminalId(), new Set(Object.keys(state.sessions)), now);
    });

    const intervalId = window.setInterval(() => {
      void sampleAllTerminals();
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
