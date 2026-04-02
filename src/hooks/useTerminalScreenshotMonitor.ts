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
    const idleEligibleSince = new Map<string, number>();
    const scheduledSamples = new Set<number>();
    let isSampling = false;
    let isDisposed = false;
    let previousActiveTabRootTerminalId = getActiveTabRootTerminalId();

    const resetIdleWindowForTab = (
      tabRootTerminalId: string | null,
      sessionIds: Set<string>,
      now: number
    ) => {
      if (!tabRootTerminalId) {
        return;
      }

      const store = useTerminalStore.getState();
      for (const terminalId of getTabTerminalIds(tabRootTerminalId, sessionIds)) {
        idleEligibleSince.set(terminalId, now);
        store.setPossiblyDone(terminalId, false);
        store.setLongInactive(terminalId, false);
      }
    };

    const syncActiveTabIdleWindow = (sessionIds: Set<string>, now: number) => {
      const activeTabRootTerminalId = getActiveTabRootTerminalId();
      if (previousActiveTabRootTerminalId !== activeTabRootTerminalId) {
        resetIdleWindowForTab(previousActiveTabRootTerminalId, sessionIds, now);
      }
      resetIdleWindowForTab(activeTabRootTerminalId, sessionIds, now);
      previousActiveTabRootTerminalId = activeTabRootTerminalId;
      return new Set(getTabTerminalIds(activeTabRootTerminalId, sessionIds));
    };

    const sampleAllTerminals = async () => {
      if (isSampling || isDisposed) {
        return;
      }

      isSampling = true;
      const now = Date.now();
      try {
        const store = useTerminalStore.getState();
        const terminalIds = Object.keys(store.sessions);
        const activeIds = new Set(terminalIds);
        const activeTabTerminalIds = syncActiveTabIdleWindow(activeIds, now);

        for (const terminalId of previousHashes.keys()) {
          if (!activeIds.has(terminalId)) {
            previousHashes.delete(terminalId);
            lastChangedAt.delete(terminalId);
            idleEligibleSince.delete(terminalId);
          }
        }

        for (const terminalId of terminalIds) {
          ensureTerminalScreenshotTarget(terminalId, store.sessions[terminalId]?.cwd);
          const screenshot = captureTerminalScreenshot(terminalId);
          if (screenshot === null) {
            continue;
          }

          const hash = await hashScreenshot(screenshot);
          if (isDisposed) {
            return;
          }

          const previousHash = previousHashes.get(terminalId) ?? null;
          const changed = previousHash !== hash;
          const changedAt = changed ? now : (lastChangedAt.get(terminalId) ?? now);
          const idleStartedAt = Math.max(
            changedAt,
            idleEligibleSince.get(terminalId) ?? changedAt
          );
          const isActiveTabTerminal = activeTabTerminalIds.has(terminalId);
          const isPossiblyDone =
            !isActiveTabTerminal &&
            !changed &&
            now - idleStartedAt >= SCREENSHOT_INACTIVITY_MS;
          const isLongInactive =
            !isActiveTabTerminal &&
            !changed &&
            now - idleStartedAt >= SCREENSHOT_LONG_INACTIVITY_MS;

          previousHashes.set(terminalId, hash);
          lastChangedAt.set(terminalId, changedAt);
          if (isActiveTabTerminal) {
            idleEligibleSince.set(terminalId, now);
          }
          store.setPossiblyDone(terminalId, isPossiblyDone);
          store.setLongInactive(terminalId, isLongInactive);
          pushScreenshotDebug({
            terminalId,
            hash,
            previousHash,
            changed,
            isPossiblyDone,
            isLongInactive,
            imageDataUrl: screenshot,
          });
        }
      } finally {
        isSampling = false;
      }
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
      syncActiveTabIdleWindow(new Set(Object.keys(state.sessions)), now);
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
