import { useEffect, useState } from "react";
import type { AppStateSnapshot } from "../lib/appStateSnapshot";
import {
  applySharedAppState,
  buildAppStateSnapshot,
  getAppStateSignature,
  getLiveAppStateCounts,
  hasLiveAppState,
  parseAppStateSnapshot,
  restoreAppStateSnapshot,
  snapshotHasAppState,
  writeAppStateSnapshotToLocalStorage,
} from "../lib/appStateSnapshot";
import { getClientId } from "../lib/clientId";
import { debugLog } from "../lib/debugLog";
import { applyDocumentPatch, buildDocumentPatch } from "../lib/documentPatch";
import {
  isPrimaryClient,
  performAction,
  registerActionHandler,
  setAppStatePublishFlusher,
} from "../lib/replication";
import { onAppStateChanged } from "../lib/terminalEvents";
import {
  readAppStateBackup,
  readSharedAppState,
  writeAppStateBackup,
} from "../lib/tauriCommands";
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
    let lastSavedSignature = "";
    let lastSaveLogAt = 0;
    // The last document this client and the desktop agreed on. A replica diffs
    // against it so it sends only what the user changed here.
    let syncBase: AppStateSnapshot | null = null;
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

      // Compare contents rather than the serialized snapshot: the timestamp
      // alone would make every save look like a change, and each save is also
      // broadcast to the other clients.
      const signature = getAppStateSignature(snapshot);
      if (signature === lastSavedSignature) {
        return;
      }
      lastSavedSignature = signature;

      // A replica must not publish the whole document — its copy is a moment
      // that has already moved on, so republishing it would undo whatever the
      // desktop changed meanwhile. Send just this client's edits instead.
      if (!isPrimaryClient()) {
        const patch = syncBase ? buildDocumentPatch(syncBase, snapshot) : null;
        if (patch) {
          performAction("documentPatch", patch);
          syncBase = snapshot;
        }
        return;
      }

      const raw = JSON.stringify(snapshot);
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

    /**
     * Adopt state another client just published. Recording its signature as
     * already-saved is what keeps the two clients from echoing the same
     * snapshot back at each other.
     */
    const applyRemoteState = (raw: string, source: string) => {
      const snapshot = parseAppStateSnapshot(raw);
      if (!snapshot) {
        debugLog("app.persistence", "invalid shared state json", { source });
        return false;
      }

      const result = applySharedAppState(snapshot, source);
      if (result.restored) {
        const applied = buildAppStateSnapshot();
        lastSavedSignature = getAppStateSignature(applied);
        syncBase = applied;
        hasSeenAppState = true;
      }
      return result.restored;
    };

    /**
     * Mirror tab, layout and note changes made in the other Dispatcher clients
     * — the native window and any browser tabs — into this one.
     */
    const startSharedStateSync = async () => {
      const unlisten = await onAppStateChanged((payload) => {
        if (disposed || payload.originClientId === getClientId()) {
          return;
        }
        applyRemoteState(payload.content, "shared-state-sync");
      });

      if (disposed) {
        unlisten();
        return;
      }
      unsubscribers.push(unlisten);
    };

    const initialize = async () => {
      // A client joining a session that is already running adopts what the
      // other clients are showing; its own persisted copy may be stale.
      let adoptedSharedState = false;
      try {
        const shared = await readSharedAppState();
        if (shared) {
          adoptedSharedState = applyRemoteState(shared, "shared-state-join");
        }
      } catch (error) {
        debugLog("app.persistence", "failed to read shared app state", {
          error: error instanceof Error ? error.message : String(error),
        });
      }

      if (!adoptedSharedState && !hasLiveAppState()) {
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
      void startSharedStateSync();
      // An action relayed from a replica should show up there promptly rather
      // than after the save debounce.
      setAppStatePublishFlusher(() => {
        clearSaveTimer();
        void saveNow();
      });
      unsubscribers.push(
        registerActionHandler("documentPatch", (patch) => {
          applyDocumentPatch(patch);
        })
      );
      setBootstrapComplete(true);
      void saveNow();
    };

    void initialize();

    return () => {
      disposed = true;
      setAppStatePublishFlusher(null);
      clearSaveTimer();
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
    };
  }, []);

  return bootstrapComplete;
}
