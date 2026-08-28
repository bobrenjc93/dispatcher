import { useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getClientId } from "../lib/clientId";
import { debugLog } from "../lib/debugLog";
import {
  isPrimaryClient,
  isReplicaClient,
  initReplicaCount,
  markReplicaEventSeen,
  performAction,
  registerActionHandler,
  requestMirrorSnapshot,
  setReplicaCount,
  startActionListener,
  startMirrorConsumer,
  type ActionName,
  type ReplicatedActions,
} from "../lib/replication";
import {
  applyMirroredTerminalOutput,
  applyMirroredTerminalSize,
  resetMirroredTerminal,
} from "./useTerminalBridge";

/**
 * Declares an action the desktop window knows how to perform, and hands back a
 * callback that performs it in the right place: directly here on the desktop,
 * or relayed to the desktop from a browser replica.
 *
 * Wrapping a handler this way is what lets the UI stay identical in both
 * runtimes — a button does not need to know which one it is running in.
 */
export function useReplicatedAction<K extends ActionName>(
  name: K,
  handler: ReplicatedActions[K]
): ReplicatedActions[K] {
  useEffect(() => registerActionHandler(name, handler), [name, handler]);

  return useMemo(
    () =>
      ((...args: Parameters<ReplicatedActions[K]>) =>
        performAction(name, ...args)) as ReplicatedActions[K],
    [name]
  );
}

/**
 * Connects this client to its counterpart: the desktop window performs relayed
 * actions and mirrors terminal output; a replica renders what arrives.
 */
export function useReplicationChannels() {
  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const track = (unlisten: () => void) => {
      if (disposed) {
        unlisten();
        return;
      }
      unlisteners.push(unlisten);
    };

    if (isPrimaryClient()) {
      void invoke("set_primary_client", { clientId: getClientId() }).catch(() => {});
      void startActionListener().then(track);

      // Mirroring costs an IPC hop per frame, so it only runs while at least
      // one browser replica is actually watching.
      void invoke<number>("get_replica_count")
        .then((count) => initReplicaCount(count))
        .catch(() => {});
      void listen<number>("dispatcher-replicas", (event) => {
        markReplicaEventSeen();
        setReplicaCount(event.payload ?? 0);
      }).then(track);
    }

    if (isReplicaClient()) {
      void startMirrorConsumer((frame) => {
        switch (frame.kind) {
          case "output":
            applyMirroredTerminalOutput(frame.terminalId, frame.data);
            return;
          case "size":
            applyMirroredTerminalSize(frame.terminalId, frame.cols, frame.rows);
            return;
          case "reset":
            resetMirroredTerminal(frame.terminalId);
            return;
        }
      }).then((unlisten) => {
        track(unlisten);
        // Only ask for the backlog once the consumer is listening, or the
        // reply would arrive before anything could apply it.
        requestMirrorSnapshot();
        debugLog("replication", "replica requested initial snapshot", {
          clientId: getClientId(),
        });
      });
    }

    return () => {
      disposed = true;
      for (const unlisten of unlisteners) {
        unlisten();
      }
    };
  }, []);
}
