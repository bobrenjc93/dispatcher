import { useEffect, useState } from "react";
import {
  buildAppStateSnapshot,
  getLiveAppStateCounts,
  hasLiveAppState,
  parseAppStateSnapshot,
  restoreAppStateSnapshot,
  snapshotHasAppState,
  writeAppStateSnapshotToLocalStorage,
} from "../lib/appStateSnapshot";
import { debugLog } from "../lib/debugLog";
import { readAppStateBackup, writeAppStateBackup } from "../lib/tauriCommands";
import { useLayoutStore } from "../stores/useLayoutStore";
import { useProjectStore } from "../stores/useProjectStore";
import { useTerminalStore } from "../stores/useTerminalStore";

const BACKUP_SAVE_DEBOUNCE_MS = 1_000;
const BACKUP_SAVE_LOG_INTERVAL_MS = 15_000;

export function useAppStateBackup() {
  const [bootstrapComplete, setBootstrapComplete] = useState(false);

  useEffect(() => {
    let disposed = false;
    let readyToSave = false;
    let hasSeenAppState = hasLiveAppState();
    let saveTimer: number | null = null;
    let lastSavedRaw = "";
    let lastSaveLogAt = 0;
    let unsubscribers: Array<() => void> = [];

    const clearSaveTimer = () => {
      if (saveTimer !== null) {
        window.clearTimeout(saveTimer);
        saveTimer = null;
      }
    };

    const saveNow = async () => {
      if (disposed || !readyToSave) {
        return;
      }

      const snapshot = buildAppStateSnapshot();
      const hasState = snapshotHasAppState(snapshot);
      if (!hasState && !hasSeenAppState) {
        return;
      }
      hasSeenAppState = hasSeenAppState || hasState;

      writeAppStateSnapshotToLocalStorage(snapshot);

      const raw = JSON.stringify(snapshot);
      if (raw === lastSavedRaw) {
        return;
      }
      lastSavedRaw = raw;

      try {
        const path = await writeAppStateBackup(raw);
        const now = Date.now();
        if (now - lastSaveLogAt >= BACKUP_SAVE_LOG_INTERVAL_MS) {
          lastSaveLogAt = now;
          debugLog("app.persistence", "wrote app state backup", {
            path,
            bytes: raw.length,
            counts: getLiveAppStateCounts(),
          });
        }
      } catch (error) {
        debugLog("app.persistence", "failed to write app state backup", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    const scheduleSave = () => {
      if (disposed || !readyToSave) {
        return;
      }

      clearSaveTimer();
      saveTimer = window.setTimeout(() => {
        saveTimer = null;
        void saveNow();
      }, BACKUP_SAVE_DEBOUNCE_MS);
    };

    const startSubscriptions = () => {
      unsubscribers = [
        useProjectStore.subscribe(scheduleSave),
        useTerminalStore.subscribe(scheduleSave),
        useLayoutStore.subscribe(scheduleSave),
      ];
    };

    const initialize = async () => {
      if (!hasLiveAppState()) {
        try {
          const raw = await readAppStateBackup();
          if (raw && !hasLiveAppState()) {
            const snapshot = parseAppStateSnapshot(raw);
            if (snapshot) {
              const result = restoreAppStateSnapshot(snapshot, "app-state-backup");
              hasSeenAppState = hasSeenAppState || result.restored;
            } else {
              debugLog("app.persistence", "invalid app state backup json");
            }
          }
        } catch (error) {
          debugLog("app.persistence", "failed to read app state backup", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (disposed) {
        return;
      }

      readyToSave = true;
      hasSeenAppState = hasSeenAppState || hasLiveAppState();
      startSubscriptions();
      setBootstrapComplete(true);
      void saveNow();
    };

    void initialize();

    return () => {
      disposed = true;
      clearSaveTimer();
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
    };
  }, []);

  return bootstrapComplete;
}
