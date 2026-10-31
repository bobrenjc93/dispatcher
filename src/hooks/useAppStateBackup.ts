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
import {
  applyDocumentPatch,
  buildDocumentPatch,
  isDocumentPatchReflected,
  type DocumentPatch,
} from "../lib/documentPatch";
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
/**
 * The longest a change waits to be saved and published, however busy the
 * stores are. A trailing debounce alone restarts on every store change, and a
 * terminal printing steadily changes the store many times a second -- so a
 * rename or a tick made while any tab was busy reached the phones whenever the
 * output happened to pause, which could be many seconds later.
 */
const BACKUP_SAVE_MAX_WAIT_MS = 2_000;
const BACKUP_SAVE_LOG_INTERVAL_MS = 15_000;
/**
 * How soon a replica sends what was changed on it. One frame, so the several
 * steps of a multi-row drag go as one patch -- but not the save debounce. The
 * desktop republishes on its own all the time, and every copy it published
 * while a phone's edit sat waiting to be sent was adopted over it: a dragged
 * tab jumped back, and was lost outright if nothing sent it afterwards.
 */
const REPLICA_PATCH_DELAY_MS = 16;
/**
 * How long a replica holds its own edit over copies from the desktop that do
 * not show it yet. Long past any round trip; an edit still missing after this
 * was not applied, and holding it longer would only fight the desktop.
 */
const PENDING_PATCH_TTL_MS = 10_000;

export function useAppStateBackup() {
  const [bootstrapComplete, setBootstrapComplete] = useState(false);

  useEffect(() => {
    let disposed = false;
    let readyToSave = false;
    let hasSeenAppState = hasLiveAppState();
    let saveTimer: number | null = null;
    // When the oldest change not yet saved was made.
    let pendingSince: number | null = null;
    let lastSavedSignature = "";
    let lastSaveLogAt = 0;
    // The last document this client and the desktop agreed on. A replica diffs
    // against it so it sends only what the user changed here.
    let syncBase: AppStateSnapshot | null = null;
    let unsubscribers: Array<() => void> = [];
    // Edits this replica sent that the desktop has not yet published back.
    let pendingPatches: Array<{ patch: DocumentPatch; sentAt: number }> = [];
    let replicaPatchTimer: number | null = null;

    const clearSaveTimer = () => {
      if (saveTimer !== null) {
        window.clearTimeout(saveTimer);
        saveTimer = null;
      }
      pendingSince = null;
    };

    /** Send a replica's edits now, rather than when the backup is next saved. */
    const flushReplicaPatch = () => {
      if (replicaPatchTimer !== null) {
        window.clearTimeout(replicaPatchTimer);
        replicaPatchTimer = null;
      }
      if (disposed || !readyToSave || isPrimaryClient() || !syncBase) {
        return;
      }
      const snapshot = buildAppStateSnapshot();
      const patch = buildDocumentPatch(syncBase, snapshot);
      if (!patch) {
        return;
      }
      performAction("documentPatch", patch);
      pendingPatches.push({ patch, sentAt: Date.now() });
      syncBase = snapshot;
    };

    const scheduleReplicaPatch = () => {
      if (disposed || !readyToSave || isPrimaryClient() || replicaPatchTimer !== null) {
        return;
      }
      replicaPatchTimer = window.setTimeout(flushReplicaPatch, REPLICA_PATCH_DELAY_MS);
    };

    /**
     * Put back this replica's edits that a copy from the desktop predates.
     *
     * Applied oldest first, and dropped once a copy carries them or they are
     * too old to still be on their way.
     */
    const holdPendingPatches = (remote: AppStateSnapshot) => {
      const now = Date.now();
      pendingPatches = pendingPatches.filter(
        (entry) => now - entry.sentAt < PENDING_PATCH_TTL_MS && !isDocumentPatchReflected(entry.patch, remote)
      );
      for (const entry of pendingPatches) {
        applyDocumentPatch(entry.patch);
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
        flushReplicaPatch();
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

      const now = Date.now();
      const since = pendingSince ?? now;
      clearSaveTimer();
      pendingSince = since;
      const delay = Math.min(BACKUP_SAVE_DEBOUNCE_MS, Math.max(0, since + BACKUP_SAVE_MAX_WAIT_MS - now));
      saveTimer = window.setTimeout(() => {
        saveTimer = null;
        pendingSince = null;
        void saveNow();
      }, delay);
    };

    const onStoreChange = () => {
      scheduleReplicaPatch();
      scheduleSave();
    };

    const startSubscriptions = () => {
      unsubscribers = [
        useProjectStore.subscribe(onStoreChange),
        useTerminalStore.subscribe(onStoreChange),
        useLayoutStore.subscribe(onStoreChange),
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

      // Anything changed here and not sent yet goes first, so it is diffed
      // against the copy it was made on rather than lost under the new one.
      if (!isPrimaryClient()) {
        flushReplicaPatch();
      }
      const result = applySharedAppState(snapshot, source);
      if (result.restored) {
        if (!isPrimaryClient()) {
          holdPendingPatches(snapshot);
        }
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
      if (replicaPatchTimer !== null) {
        window.clearTimeout(replicaPatchTimer);
      }
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
    };
  }, []);

  return bootstrapComplete;
}
