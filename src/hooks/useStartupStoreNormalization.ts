import { useEffect } from "react";
import { debugLog } from "../lib/debugLog";
import { isPrimaryClient } from "../lib/replication";
import { normalizeRestoredTmuxState } from "../lib/restoredTmuxState";
import { listLiveTerminals } from "../lib/tauriCommands";
import { resumeLiveControlSessions } from "../lib/tmuxControl";
import { useLayoutStore } from "../stores/useLayoutStore";
import { useProjectStore } from "../stores/useProjectStore";
import { useTerminalStore } from "../stores/useTerminalStore";

export function useStartupStoreNormalization() {
  useEffect(() => {
    // Downgrading tmux tabs to placeholders after a restart is the desktop
    // window's call. A replica doing it would rewrite the shared workspace and
    // tear down tmux tabs that are perfectly alive on the desktop.
    if (!isPrimaryClient()) {
      return;
    }

    let disposed = false;

    void (async () => {
      // PTYs outlive the UI. Anything still running can be reattached rather
      // than rebuilt, which for an ssh + tmux tab saves re-authenticating and
      // re-attaching by hand — the whole point of keeping them separate.
      // Left undefined when the backend cannot be asked. Normalization treats
      // that as "unknown" and keeps the tmux tabs, rather than concluding
      // nothing is alive and deleting transports that are running perfectly
      // well — which cannot be undone and costs the user an ssh and a
      // `tmux -CC a` per tab.
      let liveTerminalIds: Set<string> | undefined;
      try {
        liveTerminalIds = new Set(await listLiveTerminals());
      } catch (error) {
        debugLog("startup.normalize", "could not list live terminals, keeping tmux tabs", {
          error: error instanceof Error ? error.message : String(error),
        });
      }

      if (disposed) {
        return;
      }

      const normalized = normalizeRestoredTmuxState({
        liveTerminalIds,
        sessions: useTerminalStore.getState().sessions,
        activeTerminalId: useTerminalStore.getState().activeTerminalId,
        projects: useProjectStore.getState().projects,
        nodes: useProjectStore.getState().nodes,
        activeProjectId: useProjectStore.getState().activeProjectId,
        projectOrder: useProjectStore.getState().projectOrder,
        layouts: useLayoutStore.getState().layouts,
      });

      if (normalized.changed) {
        useProjectStore.setState({
          projects: normalized.projects,
          nodes: normalized.nodes,
          activeProjectId: normalized.activeProjectId,
          projectOrder: normalized.projectOrder,
        });
        useLayoutStore.setState({
          layouts: normalized.layouts,
        });
        useTerminalStore.setState({
          sessions: normalized.sessions,
          activeTerminalId: normalized.activeTerminalId,
        });

        debugLog("startup.normalize", "restored tmux state normalized", {
          projects: Object.keys(normalized.projects).length,
          nodes: Object.keys(normalized.nodes).length,
          layouts: Object.keys(normalized.layouts).length,
          sessions: Object.keys(normalized.sessions).length,
          activeProjectId: normalized.activeProjectId,
          activeTerminalId: normalized.activeTerminalId,
        });
      }

      resumeLiveControlSessions(liveTerminalIds ?? new Set());
    })();

    return () => {
      disposed = true;
    };
  }, []);
}
