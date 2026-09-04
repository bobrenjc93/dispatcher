import { useEffect, useCallback, useState, useRef } from "react";
import { Sidebar } from "./components/Sidebar/Sidebar";
import { ProjectView } from "./components/Layout/ProjectView";
import { rememberPushSubscription } from "./lib/pushRegistry";
import { enablePushNotifications } from "./lib/webPushSubscribe";
import { PushSetupPrompt } from "./components/common/PushSetupPrompt";
import { KeyDebugOverlay } from "./components/common/KeyDebugOverlay";
import { NameDialog } from "./components/common/NameDialog";
import { MobileKeyBar } from "./components/Terminal/MobileKeyBar";
import { useProjectStore } from "./stores/useProjectStore";
import { useLayoutStore } from "./stores/useLayoutStore";
import { useTerminalStore } from "./stores/useTerminalStore";
import { useFontStore } from "./stores/useFontStore";
import { useColorSchemeStore } from "./stores/useColorSchemeStore";
import { useUiStore } from "./stores/useUiStore";
import { applyTerminalBackgroundVar, applyUIColors } from "./lib/colorSchemes";
import type { ColorScheme } from "./types/colorScheme";
import {
  isCloseTabShortcut,
  isRenameTerminalShortcut,
  isRepeatedCloseTabShortcut,
  shouldBypassAppShortcutsForTerminal,
} from "./lib/keyboardShortcuts";
import { findTerminalIds, findLayoutKeyForTerminal, findSiblingTerminalId } from "./lib/layoutUtils";
import { closeTerminal, warmPool, refreshPool, getTerminalCwd, writeTerminal } from "./lib/tauriCommands";
import {
  disposeTerminalInstance,
  focusTerminalInstance,
  refitAllTerminalsToViewport,
  presentTerminalForViewport,
  scrollTerminalToBottom,
} from "./hooks/useTerminalBridge";
import { useFileDrop } from "./hooks/useFileDrop";
import { useAppStateBackup } from "./hooks/useAppStateBackup";
import { useRecoveryBootstrap } from "./hooks/useRecoveryBootstrap";
import { useStartupStoreNormalization } from "./hooks/useStartupStoreNormalization";
import { useTerminalScreenshotMonitor } from "./hooks/useTerminalScreenshotMonitor";
import { useWakeRecovery } from "./hooks/useWakeRecovery";
import { useReplicatedAction, useReplicationChannels } from "./hooks/useReplication";
import { startSessionRecording } from "./lib/sessionRecorder";
import { setAttachStalledHandler } from "./lib/tmuxAttachWatchdog";
import { queueTerminalOutput } from "./hooks/useTerminalBridge";
import { useCompactViewport } from "./hooks/useCompactViewport";
import { useSoftKeyboardViewport } from "./hooks/useSoftKeyboardViewport";
import { isPrimaryClient } from "./lib/replication";
import { debugLog } from "./lib/debugLog";
import {
  resolveTerminalCloseFocusTarget,
  type SidebarTerminalRef,
  type TerminalCloseFocusTarget,
} from "./lib/terminalCloseFocus";
import {
  closeTmuxTerminal,
  createTmuxWindowForTerminal,
  handleTransportTerminalExit,
  handleTmuxTerminalFocus,
  isDisconnectedTmuxPlaceholderTerminal,
  isLiveTmuxTerminal,
  resolvePreferredTerminalFocus,
  splitTmuxTerminal,
} from "./lib/tmuxControl";
import { onTerminalExit } from "./lib/terminalEvents";
import { collectVisibleTerminalRefs, findProjectIdForTerminal, resolveSiblingInsertIndex } from "./lib/treeUtils";
import {
  APP_STATE_LAYOUTS_KEY,
  APP_STATE_PROJECTS_KEY,
  APP_STATE_TERMINALS_KEY,
  getScopedStorageKey,
  getStorageNamespaceLabel,
  isDispatcherStorageKey,
} from "./lib/storageNamespace";
import "./App.css";

const KEY_DEBUG_VISIBLE_STORAGE_KEY = getScopedStorageKey("dispatcher.keydebug.visible");

function generateId(): string {
  return crypto.randomUUID();
}

function isTmuxBackedTerminal(terminalId?: string): boolean {
  if (!terminalId) {
    return false;
  }

  return isLiveTmuxTerminal(terminalId);
}

type DialogMode =
  | { type: "new-project" }
  | { type: "new-terminal"; projectId: string }
  | { type: "new-project-with-terminal" }
  | null;

export default function App() {
  const [showKeyDebug, setShowKeyDebug] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(KEY_DEBUG_VISIBLE_STORAGE_KEY) === "1";
  });
  const projects = useProjectStore((s) => s.projects);
  const projectOrder = useProjectStore((s) => s.projectOrder);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const addProject = useProjectStore((s) => s.addProject);
  const removeProject = useProjectStore((s) => s.removeProject);
  const addNode = useProjectStore((s) => s.addNode);
  const removeNode = useProjectStore((s) => s.removeNode);
  const addChildToNode = useProjectStore((s) => s.addChildToNode);
  const insertChildAt = useProjectStore((s) => s.insertChildAt);
  const removeChildFromNode = useProjectStore((s) => s.removeChildFromNode);
  const nodes = useProjectStore((s) => s.nodes);
  const sessions = useTerminalStore((s) => s.sessions);
  const addSession = useTerminalStore((s) => s.addSession);
  const updateSessionCwd = useTerminalStore((s) => s.updateCwd);
  const removeSession = useTerminalStore((s) => s.removeSession);
  const initLayout = useLayoutStore((s) => s.initLayout);
  const splitTerminal = useLayoutStore((s) => s.splitTerminal);
  const removeTerminalFromLayout = useLayoutStore((s) => s.removeTerminal);
  const removeLayout = useLayoutStore((s) => s.removeLayout);

  const isCompact = useCompactViewport();

  // The keyboard opening or closing changes how much room the terminal has, so
  // refit it and put the newest output back in view.
  const handleSoftKeyboardViewport = useCallback(() => {
    const terminalId = useTerminalStore.getState().activeTerminalId;
    refitAllTerminalsToViewport();
    if (terminalId) {
      scrollTerminalToBottom(terminalId, { afterKeyboard: true });
    }
  }, []);
  useSoftKeyboardViewport(isCompact, handleSoftKeyboardViewport);

  // Land on the newest output rather than wherever the replay happened to
  // leave the viewport. Focus goes with it so the first tap types instead of
  // just focusing — though iOS will not raise the keyboard until that tap,
  // since it only opens one in response to a gesture.
  useEffect(() => {
    if (!isCompact) {
      return;
    }
    const timer = window.setTimeout(() => {
      const terminalId = useTerminalStore.getState().activeTerminalId;
      if (!terminalId) {
        return;
      }
      scrollTerminalToBottom(terminalId, { afterKeyboard: true });
      focusTerminalInstance(terminalId);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [isCompact]);
  const [isMobileNavOpen, setMobileNavOpen] = useState(false);
  const detailPanelCollapsed = useUiStore((s) => s.isDetailPanelCollapsed);
  const setDetailPanelCollapsed = useUiStore((s) => s.setDetailPanelCollapsed);
  const compactTerminalFit = useUiStore((s) => s.compactTerminalFit);
  const setCompactTerminalFit = useUiStore((s) => s.setCompactTerminalFit);
  const compactTouchGesture = useUiStore((s) => s.compactTouchGesture);
  const [pushStatus, setPushStatus] = useState<string | null>(null);
  useEffect(() => {
    if (!pushStatus) {
      return;
    }
    const timer = window.setTimeout(() => setPushStatus(null), 6000);
    return () => window.clearTimeout(timer);
  }, [pushStatus]);
  const setCompactTouchGesture = useUiStore((s) => s.setCompactTouchGesture);

  // The notes column has no room next to a terminal on a phone; start hidden
  // there, and restore the desktop preference when there is space again.
  const collapsedForCompactRef = useRef(false);
  useEffect(() => {
    if (isCompact && !detailPanelCollapsed) {
      collapsedForCompactRef.current = true;
      setDetailPanelCollapsed(true);
    } else if (!isCompact && collapsedForCompactRef.current) {
      collapsedForCompactRef.current = false;
      setDetailPanelCollapsed(false);
    }
    // Only react to the viewport flipping, not to the user toggling notes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCompact]);

  useFileDrop();
  useStartupStoreNormalization();
  const appStateBootstrapComplete = useAppStateBackup();
  useRecoveryBootstrap();
  useTerminalScreenshotMonitor();
  useWakeRecovery();
  useReplicationChannels();

  // Record terminal sessions so a rendering bug can be inspected afterwards.
  useEffect(() => startSessionRecording(), []);

  // A control-mode attach that never speaks leaves the tab looking frozen with
  // no explanation, so say what happened in the terminal itself.
  useEffect(() => {
    setAttachStalledHandler((terminalId) => {
      queueTerminalOutput(
        terminalId,
        "\r\n\u001b[33m[dispatcher]\u001b[0m tmux attached but sent no control-mode data.\r\n"
          + "\r\nThis is a tmux server whose binary was replaced while it was running —\r\n"
          + "usually a package upgrade some time after the server started. Such a server\r\n"
          + "still answers commands, but it can no longer finish an attach: it receives the\r\n"
          + "client's terminal descriptors and drops them, so it never sends the control-mode\r\n"
          + "preamble, and never will.\r\n"
          + "\r\nConfirm it from another shell on that host:\r\n"
          + "  readlink /proc/$(tmux display-message -p '#{pid}')/exe\r\n"
          + "  # ending in \"(deleted)\" means this is the bug\r\n"
          + "\r\nThe running server cannot be repaired, and each further attempt strands\r\n"
          + "another client on it. Save what you need, then restart it:\r\n"
          + "  tmux capture-pane -p -S - -t <pane>   # scrollback, one pane at a time\r\n"
          + "  tmux kill-server                      # destroys every session on that host\r\n"
          + "\r\nThis tab is in raw mode, so Ctrl-C will not bring the shell back. Close it.\r\n",
        { allowParkedWrite: true, recordActivity: false }
      );
    });
    return () => setAttachStalledHandler(null);
  }, []);

  useEffect(() => {
    const logStartupState = (phase: string) => {
      debugLog("app.runtime", phase, {
        projects: Object.keys(useProjectStore.getState().projects).length,
        projectOrder: useProjectStore.getState().projectOrder.length,
        nodes: Object.keys(useProjectStore.getState().nodes).length,
        sessions: Object.keys(useTerminalStore.getState().sessions).length,
        layouts: Object.keys(useLayoutStore.getState().layouts).length,
        activeProjectId: useProjectStore.getState().activeProjectId,
        activeTerminalId: useTerminalStore.getState().activeTerminalId,
        storageNamespace: getStorageNamespaceLabel(),
        localStorageLength: window.localStorage.length,
        localStorageKeys: Array.from({ length: window.localStorage.length }, (_, index) => window.localStorage.key(index))
          .filter((key): key is string => key !== null && isDispatcherStorageKey(key)),
        hasPersistedProjects: window.localStorage.getItem(getScopedStorageKey(APP_STATE_PROJECTS_KEY)) !== null,
        hasPersistedTerminals: window.localStorage.getItem(getScopedStorageKey(APP_STATE_TERMINALS_KEY)) !== null,
        hasPersistedLayouts: window.localStorage.getItem(getScopedStorageKey(APP_STATE_LAYOUTS_KEY)) !== null,
      });
    };

    logStartupState("mounted");
    const hydrationCheck = window.setTimeout(() => logStartupState("mounted after hydration delay"), 1_000);
    return () => window.clearTimeout(hydrationCheck);
  }, []);

  const resolvedActiveProjectId = (() => {
    if (activeProjectId && projects[activeProjectId]) {
      return activeProjectId;
    }

    for (const projectId of projectOrder) {
      const project = projects[projectId];
      if (!project) {
        continue;
      }
      if (collectVisibleTerminalRefs(nodes, project.rootGroupId, sessions).length > 0) {
        return projectId;
      }
    }

    return projectOrder.find((projectId) => Boolean(projects[projectId])) ?? null;
  })();

  const activeProject = resolvedActiveProjectId ? projects[resolvedActiveProjectId] : null;

  const buildSidebarTerminalList = useCallback((): SidebarTerminalRef[] => {
    const { projects: allProjects, projectOrder, nodes: currentNodes } = useProjectStore.getState();
    const sessions = useTerminalStore.getState().sessions;
    const allTerminals: SidebarTerminalRef[] = [];

    for (const projId of projectOrder) {
      const proj = allProjects[projId];
      if (!proj || !proj.expanded) continue;
      const refs = collectVisibleTerminalRefs(currentNodes, proj.rootGroupId, sessions);
      for (const ref of refs) {
        allTerminals.push({ terminalId: ref.terminalId, projectId: projId });
      }
    }

    return allTerminals;
  }, []);

  const resolveCloseFocusTarget = useCallback(
    (terminalId: string): TerminalCloseFocusTarget | null => resolveTerminalCloseFocusTarget({
      closingTerminalId: terminalId,
      activeTerminalId: useTerminalStore.getState().activeTerminalId,
      layouts: useLayoutStore.getState().layouts,
      sidebarTerminals: buildSidebarTerminalList(),
      resolvePreferredTerminalFocus,
    }),
    [buildSidebarTerminalList]
  );

  const applyCloseFocusTarget = useCallback((target: TerminalCloseFocusTarget | null) => {
    if (!target) {
      return;
    }
    if (target.projectId) {
      useProjectStore.getState().setActiveProject(target.projectId);
    }
    useTerminalStore.getState().setActiveTerminal(target.terminalId);
    handleTmuxTerminalFocus(target.terminalId);
  }, []);

  const [dialog, setDialog] = useState<DialogMode>(null);
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const sidebarDividerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.localStorage.setItem(KEY_DEBUG_VISIBLE_STORAGE_KEY, showKeyDebug ? "1" : "0");
  }, [showKeyDebug]);

  const handleSidebarDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;

    const onMouseMove = (e: MouseEvent) => {
      const newWidth = Math.max(160, Math.min(480, startWidth + (e.clientX - startX)));
      setSidebarWidth(newWidth);
    };

    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [sidebarWidth]);

  // Pre-spawn PTY pool for instant terminal creation, and refresh
  // periodically so pooled shells have up-to-date history/env. Give the first
  // render priority over starting three login shells during a cold launch.
  useEffect(() => {
    if (!isPrimaryClient()) {
      return;
    }

    const warmTimer = window.setTimeout(() => {
      warmPool(3).catch(() => {});
    }, 1_500);
    const id = setInterval(() => refreshPool().catch(() => {}), 5 * 60 * 1000);
    return () => {
      clearTimeout(warmTimer);
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    if (!isPrimaryClient()) {
      return;
    }

    let unlisten: (() => void) | null = null;
    onTerminalExit((payload) => {
      handleTransportTerminalExit(payload.terminal_id);
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  // Apply UI colors from color scheme on mount and subscribe to changes
  useEffect(() => {
    const apply = (scheme: ColorScheme) => {
      applyUIColors(scheme.ui);
      applyTerminalBackgroundVar(scheme.terminal.background);
    };
    apply(useColorSchemeStore.getState().getActiveScheme());
    return useColorSchemeStore.subscribe((state) => apply(state.getActiveScheme()));
  }, []);

  // Sync activeProjectId whenever activeTerminalId changes so that
  // Cmd+T (and other shortcuts that read activeProjectId) target the
  // correct project after clicking into a terminal pane.
  useEffect(() => {
    return useTerminalStore.subscribe((state) => {
      const activeId = state.activeTerminalId;
      if (!activeId) return;

      const { projects: allProjects, nodes: allNodes, projectOrder, activeProjectId: currentProjectId } = useProjectStore.getState();
      const allLayouts = useLayoutStore.getState().layouts;
      const targetTerminalId = findLayoutKeyForTerminal(allLayouts, activeId) ?? activeId;
      const projectId = findProjectIdForTerminal(
        allProjects,
        projectOrder,
        allNodes,
        state.sessions,
        targetTerminalId
      );

      if (projectId && projectId !== currentProjectId) {
        useProjectStore.getState().setActiveProject(projectId);
      }
    });
  }, []);

  useEffect(() => {
    if (resolvedActiveProjectId && resolvedActiveProjectId !== activeProjectId) {
      useProjectStore.getState().setActiveProject(resolvedActiveProjectId);
    }
  }, [resolvedActiveProjectId, activeProjectId]);

  const createProjectWithTerminal = useCallback(
    (projectName: string, terminalName: string) => {
      const projId = generateId();
      const rootGroupId = generateId();
      const terminalId = generateId();

      addProject({
        id: projId,
        name: projectName,
        cwd: "",
        rootGroupId,
        expanded: true,
      });

      addNode({
        id: rootGroupId,
        type: "group",
        name: "Root",
        children: [],
        parentId: null,
      });

      const nodeId = generateId();
      addNode({
        id: nodeId,
        type: "terminal",
        name: terminalName,
        terminalId,
        parentId: rootGroupId,
      });
      addChildToNode(rootGroupId, nodeId);

      addSession(terminalId, terminalName);
      initLayout(terminalId, terminalId);
    },
    [addProject, addNode, addChildToNode, addSession, initLayout]
  );


  const createTerminalInProject = useCallback(
    async (projectId: string, terminalName: string, sourceTerminalId?: string) => {
      const project = projects[projectId];
      if (!project) return;

      // Expand the project if it's minimized so the new terminal is visible
      if (!project.expanded) {
        useProjectStore.getState().toggleProjectExpanded(projectId);
      }

      const allNodes = useProjectStore.getState().nodes;
      const sessions = useTerminalStore.getState().sessions;
      const fallbackSourceTerminalId = [...collectVisibleTerminalRefs(allNodes, project.rootGroupId, sessions)]
        .reverse()
        .map((ref) => ref.terminalId)[0];
      const cwdSourceTerminalId = sourceTerminalId ?? fallbackSourceTerminalId;

      let inheritedCwd = cwdSourceTerminalId
        ? useTerminalStore.getState().sessions[cwdSourceTerminalId]?.cwd
        : undefined;
      if (!inheritedCwd && cwdSourceTerminalId) {
        inheritedCwd = (await getTerminalCwd(cwdSourceTerminalId).catch(() => null)) ?? undefined;
        if (inheritedCwd) {
          updateSessionCwd(cwdSourceTerminalId, inheritedCwd);
        }
      }

      const terminalId = generateId();
      const nodeId = generateId();

      addNode({
        id: nodeId,
        type: "terminal",
        name: terminalName,
        terminalId,
        parentId: project.rootGroupId,
      });
      // tmux tabs already open directly below the focused one via
      // `new-window -a`; this is the same rule for local terminals, which
      // until now were always appended to the end of the list.
      const latestNodes = useProjectStore.getState().nodes;
      const insertIndex = resolveSiblingInsertIndex(
        latestNodes[project.rootGroupId]?.children ?? [],
        latestNodes,
        sourceTerminalId
      );
      if (insertIndex === null) {
        addChildToNode(project.rootGroupId, nodeId);
      } else {
        insertChildAt(project.rootGroupId, nodeId, insertIndex);
      }

      addSession(terminalId, terminalName, inheritedCwd);
      // Each tab terminal gets its own standalone layout
      initLayout(terminalId, terminalId);
    },
    [projects, addNode, addChildToNode, insertChildAt, addSession, initLayout, updateSessionCwd]
  );

  const handleNewTerminalLocal = useCallback(() => {
    const currentProjectId = useProjectStore.getState().activeProjectId;
    const currentProject = currentProjectId ? useProjectStore.getState().projects[currentProjectId] : null;
    const activeTerminalId = useTerminalStore.getState().activeTerminalId ?? undefined;
    const shouldStayInTmux = isTmuxBackedTerminal(activeTerminalId);
    void createTmuxWindowForTerminal(activeTerminalId ?? "")
      .then((handled) => {
        if (handled) {
          return;
        }
        if (shouldStayInTmux) {
          return;
        }
        if (currentProject) {
          createTerminalInProject(currentProject.id, "Shell", activeTerminalId);
          return;
        }
        setDialog({ type: "new-project-with-terminal" });
      })
      .catch(() => {
        if (shouldStayInTmux) {
          return;
        }
        if (currentProject) {
          createTerminalInProject(currentProject.id, "Shell", activeTerminalId);
          return;
        }
        setDialog({ type: "new-project-with-terminal" });
      });
  }, [createTerminalInProject]);

  const handleNewProject = useCallback(() => {
    setDialog({ type: "new-project" });
  }, []);

  const handleNewTerminalInProjectLocal = useCallback(
    (projectId: string) => {
      const activeProjectId = useProjectStore.getState().activeProjectId;
      const activeTerminalId = useTerminalStore.getState().activeTerminalId ?? undefined;
      const sourceTerminalId = activeProjectId === projectId ? activeTerminalId : undefined;
      void createTerminalInProject(projectId, "Shell", sourceTerminalId);
    },
    [createTerminalInProject]
  );

  const handleMoveTerminal = useCallback(
    (
      terminalId: string,
      fromProjectId: string,
      toProjectId: string,
      targetParentNodeId?: string,
      targetNodeId?: string,
      position?: "before" | "after"
    ) => {
      const fromProject = projects[fromProjectId];
      const toProject = projects[toProjectId];
      if (!fromProject || !toProject) return;

      // Find the tree node for this terminal in the source project
      const fromRoot = nodes[fromProject.rootGroupId];
      if (!fromRoot?.children) return;

      let treeNodeId: string | null = null;
      for (const childId of fromRoot.children) {
        const child = nodes[childId];
        if (child?.type === "terminal" && child.terminalId === terminalId) {
          treeNodeId = childId;
          break;
        }
      }
      if (!treeNodeId) return;

      // Each tab terminal owns its own layout (keyed by terminalId),
      // so moving between projects only requires moving the tree node.
      const moveNode = useProjectStore.getState().moveNode;
      const reorderChild = useProjectStore.getState().reorderChild;
      const destinationParentId = targetParentNodeId ?? toProject.rootGroupId;

      moveNode(treeNodeId, destinationParentId);

      if (targetNodeId && position) {
        reorderChild(destinationParentId, treeNodeId, targetNodeId, position);
      }
    },
    [projects, nodes]
  );

  const handleDeleteProjectLocal = useCallback(
    (projectId: string) => {
      const project = projects[projectId];
      if (!project) return;

      const allLayouts = useLayoutStore.getState().layouts;
      const rootNode = nodes[project.rootGroupId];

      // Close every tab and its split panes
      if (rootNode?.children) {
        for (const childId of rootNode.children) {
          const child = nodes[childId];
          if (child?.type === "terminal" && child.terminalId) {
            const layout = allLayouts[child.terminalId];
            if (layout) {
              for (const id of findTerminalIds(layout)) {
                closeTerminal(id).catch(() => {});
                disposeTerminalInstance(id);
                removeSession(id);
              }
            }
            removeLayout(child.terminalId);
          }
          removeNode(childId);
        }
      }
      removeNode(project.rootGroupId);
      removeProject(projectId);
    },
    [projects, nodes, removeProject, removeNode, removeSession, removeLayout]
  );

  const handleDeleteTerminalLocal = useCallback(
    (terminalId: string, projectId: string) => {
      void closeTmuxTerminal(terminalId).then((handled) => {
        if (handled) {
          return;
        }

      const project = projects[projectId];
      if (!project) return;

      // Find and remove the tree node for this terminal
      const rootNode = nodes[project.rootGroupId];
      if (rootNode?.children) {
        for (const childId of rootNode.children) {
          const child = nodes[childId];
          if (child?.type === "terminal" && child.terminalId === terminalId) {
            removeChildFromNode(project.rootGroupId, childId);
            removeNode(childId);
            break;
          }
        }
      }

      // Close all terminals in this tab (including split panes)
      const layout = useLayoutStore.getState().layouts[terminalId];
      if (layout) {
        for (const id of findTerminalIds(layout)) {
          closeTerminal(id).catch(() => {});
          disposeTerminalInstance(id);
          removeSession(id);
        }
      }
      removeLayout(terminalId);
      });
    },
    [projects, nodes, removeChildFromNode, removeNode, removeSession, removeLayout]
  );

  const handleSplitPaneLocal = useCallback(
    (targetTerminalId: string, direction: "horizontal" | "vertical") => {
      if (isDisconnectedTmuxPlaceholderTerminal(targetTerminalId)) {
        return;
      }

      void splitTmuxTerminal(targetTerminalId, direction).then((handled) => {
        if (handled) {
          return;
        }

      const allLayouts = useLayoutStore.getState().layouts;
      const layoutKey = findLayoutKeyForTerminal(allLayouts, targetTerminalId);
      if (!layoutKey) return;

      const terminalId = generateId();

      // Split panes only create a session and layout entry — no sidebar
      // tree node.  The sidebar tracks explicitly created terminals (⌘T);
      // split panes are purely a layout concern.
      addSession(terminalId, undefined);
      splitTerminal(layoutKey, targetTerminalId, terminalId, direction);

      // Look up the source terminal's actual cwd in the background
      // and cd into it once the new PTY is ready.
      getTerminalCwd(targetTerminalId)
        .then((cwd) => {
          if (cwd) {
            const escaped = cwd.replace(/'/g, "'\\''");
            writeTerminal(terminalId, ` cd '${escaped}' && clear\n`).catch(() => {});
          }
        })
        .catch(() => {});
      });
    },
    [addSession, splitTerminal]
  );

  const handleClosePaneLocal = useCallback(
    (terminalId: string) => {
      const terminal = useTerminalStore.getState().sessions[terminalId];
      const shouldPrefocusTmuxClose =
        terminal?.backendKind === "tmux-window" || terminal?.backendKind === "tmux-pane";
      const tmuxCloseFocusTarget = shouldPrefocusTmuxClose
        ? resolveCloseFocusTarget(terminalId)
        : null;
      applyCloseFocusTarget(tmuxCloseFocusTarget);

      void closeTmuxTerminal(terminalId).then((handled) => {
        if (handled) {
          return;
        }

      const projectState = useProjectStore.getState();
      const terminalState = useTerminalStore.getState();
      const allLayouts = useLayoutStore.getState().layouts;
      const layoutKey = findLayoutKeyForTerminal(allLayouts, terminalId);
      if (!layoutKey) return;
      const owningProjectId = findProjectIdForTerminal(
        projectState.projects,
        projectState.projectOrder,
        projectState.nodes,
        terminalState.sessions,
        layoutKey
      );
      const project = owningProjectId ? projectState.projects[owningProjectId] : null;
      if (!project) return;

      const isTabRoot = layoutKey === terminalId;
      const layout = allLayouts[layoutKey];
      const isSolePane = !layout || layout.type === "terminal";

      if (isSolePane) {
        applyCloseFocusTarget(resolveCloseFocusTarget(terminalId));

        removeLayout(layoutKey);
        for (const id of new Set([layoutKey, ...findTerminalIds(layout ?? { type: "terminal", id: layoutKey, terminalId })])) {
          closeTerminal(id).catch(() => {});
          disposeTerminalInstance(id);
          removeSession(id);
        }

        // Closing the only pane in a tab: remove the entire sidebar tab.
        const currentNodes = useProjectStore.getState().nodes;
        const rootNode = currentNodes[project.rootGroupId];
        if (rootNode?.children) {
          for (const childId of rootNode.children) {
            const child = currentNodes[childId];
            if (child?.type === "terminal" && child.terminalId === layoutKey) {
              removeChildFromNode(project.rootGroupId, childId);
              removeNode(childId);
              break;
            }
          }
        }
      } else {
        // Closing one pane within a split layout.
        // Find the sibling BEFORE mutating the layout so focus stays in this tab
        // instead of jumping to a terminal in a different tab.
        const sibling = layout ? findSiblingTerminalId(layout, terminalId) : null;

        closeTerminal(terminalId).catch(() => {});
        disposeTerminalInstance(terminalId);
        removeTerminalFromLayout(layoutKey, terminalId);

        // If the closed pane was the tab root, re-key the layout under a
        // surviving terminal and update the tree node to match.
        if (isTabRoot) {
          const remaining = useLayoutStore.getState().layouts[layoutKey];
          if (remaining) {
            const newKey = findTerminalIds(remaining)[0];
            // Re-key: remove old entry, insert under new key
            useLayoutStore.setState((state) => {
              const { [layoutKey]: layoutNode, ...rest } = state.layouts;
              return { layouts: { ...rest, [newKey]: layoutNode } };
            });
            // Update the tree node's terminalId to the new layout key
            const currentNodes = useProjectStore.getState().nodes;
            const rootNode = currentNodes[project.rootGroupId];
            if (rootNode?.children) {
              for (const childId of rootNode.children) {
                const child = currentNodes[childId];
                if (child?.type === "terminal" && child.terminalId === terminalId) {
                  useProjectStore.setState((state) => ({
                    nodes: {
                      ...state.nodes,
                      [childId]: { ...state.nodes[childId], terminalId: newKey },
                    },
                  }));
                  break;
                }
              }
            }
          }
        }

        if (sibling && useTerminalStore.getState().activeTerminalId === terminalId) {
          useTerminalStore.getState().setActiveTerminal(sibling);
        }
        removeSession(terminalId);
      }

      // If no more tabs remain, clean up the project
      const updatedNodes = useProjectStore.getState().nodes;
      const updatedRoot = updatedNodes[project.rootGroupId];
      if (!updatedRoot?.children || updatedRoot.children.length === 0) {
        removeNode(project.rootGroupId);
        removeProject(project.id);
      }
      });
    },
    [
      applyCloseFocusTarget,
      resolveCloseFocusTarget,
      removeTerminalFromLayout,
      removeLayout,
      removeSession,
      removeChildFromNode,
      removeNode,
      removeProject,
    ]
  );

  // Actions that start, stop or write to something real run on the desktop
  // window. In the desktop these call straight through; in a browser replica
  // they are relayed to the desktop, which performs them and mirrors back the
  // result. Everything downstream — buttons, shortcuts, menus — is unaware.
  const handleNewTerminal = useReplicatedAction("newTerminal", handleNewTerminalLocal);
  const handleNewTerminalInProject = useReplicatedAction(
    "newTerminalInProject",
    handleNewTerminalInProjectLocal
  );
  const handleDeleteProject = useReplicatedAction("deleteProject", handleDeleteProjectLocal);
  const handleDeleteTerminal = useReplicatedAction("deleteTerminal", handleDeleteTerminalLocal);
  const handleSplitPane = useReplicatedAction("splitPane", handleSplitPaneLocal);
  const handleClosePane = useReplicatedAction("closePane", handleClosePaneLocal);
  // Runs on the desktop wherever it is called from: a phone relays its
  // subscription here because it cannot notify itself once its web app closes.
  const handleRegisterPushSubscription = useReplicatedAction(
    "registerPushSubscription",
    rememberPushSubscription
  );

  // Find the layout key (tab root terminal ID) for the currently active terminal.
  const layouts = useLayoutStore((s) => s.layouts);
  const activeTerminalId = useTerminalStore((s) => s.activeTerminalId);

  // Picking a tab in the drawer should get it out of the way immediately.
  useEffect(() => {
    setMobileNavOpen(false);
  }, [activeTerminalId]);

  // A tab arriving from the parking lot keeps the font it had when it was last
  // shown, which on a phone renders enormous until something re-fits it.
  //
  // Scrolling history is something you go into for the tab you are reading,
  // not a setting that follows you around: it hides the rows above the fold,
  // which is rarely what you want the moment a different tab appears. Every
  // tab therefore opens on Pan, showing the whole grid.
  useEffect(() => {
    if (!isCompact || !activeTerminalId) {
      return;
    }
    setCompactTouchGesture("pan");
    presentTerminalForViewport(activeTerminalId);
  }, [isCompact, activeTerminalId, setCompactTouchGesture]);
  const activeLayoutKey = (() => {
    if (!activeProject) return null;
    if (activeTerminalId) {
      const layoutKey = findLayoutKeyForTerminal(layouts, activeTerminalId);
      if (layoutKey) {
        return layoutKey;
      }
    }

    const refs = collectVisibleTerminalRefs(nodes, activeProject.rootGroupId, sessions);
    return refs[0]?.terminalId ?? null;
  })();

  useEffect(() => {
    if (!activeProject || activeLayoutKey) {
      return;
    }

    const refs = collectVisibleTerminalRefs(nodes, activeProject.rootGroupId, sessions);
    if (refs.length === 0) {
      return;
    }

    const preferredTerminalId = resolvePreferredTerminalFocus(refs[0].terminalId);
    if (preferredTerminalId !== useTerminalStore.getState().activeTerminalId) {
      useTerminalStore.getState().setActiveTerminal(preferredTerminalId);
      handleTmuxTerminalFocus(preferredTerminalId);
    }
  }, [activeProject, activeLayoutKey, nodes, sessions]);

  // Only offer first-project creation after the native backup has had a chance
  // to restore a workspace when WebKit storage is empty or was reset.
  useEffect(() => {
    if (appStateBootstrapComplete && Object.keys(projects).length === 0) {
      setDialog({ type: "new-project-with-terminal" });
    }
  }, [appStateBootstrapComplete, projects]);

  // Keyboard shortcuts — use a ref so the listener is registered once and never
  // torn down/re-added when dependencies like activeProject change.  This
  // Track last-focused pane per tab so we can restore focus when cycling back.
  const lastFocusedPane = useRef(new Map<string, string>());
  useEffect(() => {
    return useTerminalStore.subscribe((state) => {
      const activeId = state.activeTerminalId;
      if (!activeId) return;
      const layouts = useLayoutStore.getState().layouts;
      // If activeId is inside a split layout, record it under the tab root.
      const tabRoot = findLayoutKeyForTerminal(layouts, activeId);
      if (tabRoot) {
        lastFocusedPane.current.set(tabRoot, activeId);
      } else if (layouts[activeId]) {
        // activeId IS the tab root itself (single pane or root pane focused).
        lastFocusedPane.current.set(activeId, activeId);
      }
    });
  }, []);

  // prevents keydown events from being lost during effect re-registration
  // (particularly noticeable when cycling wraps across projects).
  const keyDownRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyDownRef.current = (e: KeyboardEvent) => {
    if (e.metaKey && e.shiftKey && e.code === "Slash") {
      e.preventDefault();
      setShowKeyDebug((value) => !value);
      return;
    }

    if (dialog) return; // Don't handle shortcuts while dialog is open
    // On macOS use Cmd for app shortcuts so Ctrl passes through to the
    // terminal (Ctrl+R reverse search, Ctrl+D EOF, Ctrl+W delete word, etc.).
    // On other platforms fall back to Ctrl as the app modifier, except when a
    // raw Ctrl+letter chord originated inside a terminal pane.
    const isMac = navigator.platform.startsWith("Mac");
    if (!isMac && shouldBypassAppShortcutsForTerminal(e)) {
      return;
    }
    const isMeta = isMac ? e.metaKey : e.ctrlKey;

    if (isMeta && !e.shiftKey && e.key === "t") {
      e.preventDefault();
      handleNewTerminal();
    }
    if (isMeta && e.shiftKey && e.key === "T") {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent("toggle-scheme-picker"));
    }
    if (isMeta && e.key === "n") {
      e.preventDefault();
      handleNewProject();
    }
    if (isMeta && !e.shiftKey && e.key === "d") {
      e.preventDefault();
      const activeTermId = useTerminalStore.getState().activeTerminalId;
      if (activeTermId && activeProject) {
        handleSplitPane(activeTermId, "horizontal");
      }
    }
    if (isMeta && e.shiftKey && e.key === "d") {
      e.preventDefault();
      const activeTermId = useTerminalStore.getState().activeTerminalId;
      if (activeTermId && activeProject) {
        handleSplitPane(activeTermId, "vertical");
      }
    }
    // Browser/WebKit sends repeated keydown events while Cmd/Ctrl+W is held.
    // Closing a tab also focuses the next tab, so treating repeats as fresh app
    // shortcuts can cascade through every restored terminal. Consume repeats but
    // only let the first non-repeat close request mutate the tab tree.
    if (isRepeatedCloseTabShortcut(e, isMac)) {
      e.preventDefault();
      debugLog("app.shortcut", "ignored repeated close tab shortcut", {
        key: e.key,
        code: e.code,
        repeat: e.repeat,
        platform: navigator.platform,
        activeTerminalId: useTerminalStore.getState().activeTerminalId,
      });
      return;
    }
    if (isCloseTabShortcut(e, isMac)) {
      e.preventDefault();
      const activeTermId = useTerminalStore.getState().activeTerminalId;
      if (activeTermId) {
        debugLog("app.shortcut", "closing active terminal from shortcut", {
          terminalId: activeTermId,
          key: e.key,
          code: e.code,
          repeat: e.repeat,
          platform: navigator.platform,
        });
        handleClosePane(activeTermId);
      }
    }
    // Rename active tab: Cmd+L, matching browser location focus. Cmd+R stays
    // as a compatibility alias; bare Ctrl+R remains terminal reverse search.
    if (isRenameTerminalShortcut(e)) {
      e.preventDefault();
      const activeTermId = useTerminalStore.getState().activeTerminalId;
      if (activeTermId) {
        // Resolve to the tab root if active terminal is inside a split layout
        const layouts = useLayoutStore.getState().layouts;
        const tabRoot = findLayoutKeyForTerminal(layouts, activeTermId);
        const targetId = tabRoot || activeTermId;
        window.dispatchEvent(new CustomEvent("rename-terminal", { detail: { terminalId: targetId } }));
      }
    }
    // Promote active tab to top of its project: Cmd+U / Ctrl+U
    if (isMeta && !e.shiftKey && e.key === "u") {
      e.preventDefault();
      const activeTermId = useTerminalStore.getState().activeTerminalId;
      if (activeTermId) {
        // If focus is inside a split, promote the owning sidebar tab.
        const layouts = useLayoutStore.getState().layouts;
        const tabRoot = findLayoutKeyForTerminal(layouts, activeTermId);
        useProjectStore.getState().promoteChild(tabRoot || activeTermId);
      }
    }
    // Demote active tab to bottom of its project: Cmd+B / Ctrl+B
    if (isMeta && !e.shiftKey && e.key === "b") {
      e.preventDefault();
      const activeTermId = useTerminalStore.getState().activeTerminalId;
      if (activeTermId) {
        const layouts = useLayoutStore.getState().layouts;
        const tabRoot = findLayoutKeyForTerminal(layouts, activeTermId);
        useProjectStore.getState().demoteChild(tabRoot || activeTermId);
      }
    }
    // Font size: Cmd+= / Cmd+- / Cmd+0
    if (isMeta && e.key === "=") {
      e.preventDefault();
      useFontStore.getState().increase();
    }
    if (isMeta && e.key === "-") {
      e.preventDefault();
      useFontStore.getState().decrease();
    }
    if (isMeta && e.key === "0") {
      e.preventDefault();
      useFontStore.getState().reset();
    }
    // Cycle projects: Cmd+] (next) / Cmd+[ (prev)
    if (isMeta && !e.shiftKey && (e.code === "BracketRight" || e.code === "BracketLeft")) {
      e.preventDefault();
      const { projectOrder, projects: allProjects, activeProjectId: currentProjId } = useProjectStore.getState();
      if (projectOrder.length < 2) return;
      const currentIdx = currentProjId ? projectOrder.indexOf(currentProjId) : -1;
      const forward = e.code === "BracketRight";
      let nextIdx: number;
      if (currentIdx === -1) {
        nextIdx = forward ? 0 : projectOrder.length - 1;
      } else if (forward) {
        nextIdx = currentIdx >= projectOrder.length - 1 ? 0 : currentIdx + 1;
      } else {
        nextIdx = currentIdx <= 0 ? projectOrder.length - 1 : currentIdx - 1;
      }
      const nextProjId = projectOrder[nextIdx];
      useProjectStore.getState().setActiveProject(nextProjId);
      // Activate first terminal in the target project
      const nextProj = allProjects[nextProjId];
      if (nextProj) {
        const currentNodes = useProjectStore.getState().nodes;
        const sessions = useTerminalStore.getState().sessions;
        const refs = collectVisibleTerminalRefs(currentNodes, nextProj.rootGroupId, sessions);
        if (refs.length > 0) {
          const preferredTerminalId = resolvePreferredTerminalFocus(refs[0].terminalId);
          useTerminalStore.getState().setActiveTerminal(preferredTerminalId);
          handleTmuxTerminalFocus(preferredTerminalId);
        }
      }
      return;
    }
    // Cycle terminals in sidebar: Cmd+Shift+] (next) / Cmd+Shift+[ (prev)
    if (isMeta && e.shiftKey && (e.code === "BracketRight" || e.code === "BracketLeft")) {
      e.preventDefault();
      const allTerminals = buildSidebarTerminalList();
      if (allTerminals.length < 2) return;
      const activeTermId = useTerminalStore.getState().activeTerminalId;
      let currentIdx = activeTermId ? allTerminals.findIndex((t) => t.terminalId === activeTermId) : -1;
      // If active terminal is a split pane (not a tab root), find its parent tab
      if (currentIdx === -1 && activeTermId) {
        const layouts = useLayoutStore.getState().layouts;
        const parentKey = findLayoutKeyForTerminal(layouts, activeTermId);
        if (parentKey) {
          currentIdx = allTerminals.findIndex((t) => t.terminalId === parentKey);
        }
      }
      const forward = e.code === "BracketRight";
      let nextIdx: number;
      if (currentIdx === -1) {
        nextIdx = forward ? 0 : allTerminals.length - 1;
      } else if (forward) {
        nextIdx = currentIdx >= allTerminals.length - 1 ? 0 : currentIdx + 1;
      } else {
        nextIdx = currentIdx <= 0 ? allTerminals.length - 1 : currentIdx - 1;
      }
      const next = allTerminals[nextIdx];
      useProjectStore.getState().setActiveProject(next.projectId);
      // Restore the pane that was last focused in this tab, or fall back to the tab root.
      const restored = lastFocusedPane.current.get(next.terminalId);
      const preferredTerminalId = restored || resolvePreferredTerminalFocus(next.terminalId);
      useTerminalStore.getState().setActiveTerminal(preferredTerminalId);
      handleTmuxTerminalFocus(preferredTerminalId);
    }
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => keyDownRef.current(e);
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleDialogConfirm = (name: string) => {
    if (dialog?.type === "new-project" || dialog?.type === "new-project-with-terminal") {
      setDialog(null);
      createProjectWithTerminal(name, "Shell");
      return;
    }
  };

  const activeTerminalTitle = activeTerminalId
    ? sessions[activeTerminalId]?.title ?? "Terminal"
    : "Dispatcher";

  return (
    <div
      className={`app${isCompact ? " app-compact" : ""}${
        isCompact && compactTouchGesture === "history" ? " touch-history" : ""
      }`}
    >
      {isCompact && (
        <div className="mobile-topbar">
          <button
            className="mobile-nav-toggle"
            aria-label={isMobileNavOpen ? "Close tabs" : "Show tabs"}
            aria-expanded={isMobileNavOpen}
            onClick={() => setMobileNavOpen((open) => !open)}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
              <path
                d="M2.5 4.5h13M2.5 9h13M2.5 13.5h13"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </button>
          <span className="mobile-topbar-title">{activeTerminalTitle}</span>
          <button
            className={`mobile-fit-toggle${compactTerminalFit === "fit-width" ? " is-active" : ""}`}
            aria-label={
              compactTerminalFit === "fit-width"
                ? "Switch to readable text"
                : "Fit the whole terminal width on screen"
            }
            aria-pressed={compactTerminalFit === "fit-width"}
            onClick={() =>
              setCompactTerminalFit(
                compactTerminalFit === "fit-width" ? "readable" : "fit-width"
              )
            }
          >
            Fit
          </button>
          <button
            className="mobile-fit-toggle"
            aria-label={
              compactTouchGesture === "pan"
                ? "Swipe to scroll history instead of moving around the grid"
                : "Swipe to move around the grid instead of scrolling history"
            }
            onClick={() =>
              setCompactTouchGesture(compactTouchGesture === "pan" ? "history" : "pan")
            }
          >
            {compactTouchGesture === "pan" ? "Scroll" : "Pan"}
          </button>
          <button
            className="mobile-fit-toggle"
            aria-label="Enable push notifications on this device"
            onClick={() => {
              // Straight out of the tap: Safari only shows the permission
              // prompt from a user gesture, and refuses it the same way the
              // user saying no looks.
              void enablePushNotifications().then((result) => {
                if (result.ok) {
                  handleRegisterPushSubscription(result.registration);
                  setPushStatus("Notifications on");
                } else {
                  setPushStatus(result.reason);
                }
              }).catch((error) => {
                setPushStatus(error instanceof Error ? error.message : String(error));
              });
            }}
          >
            Notify
          </button>
          <button
            className="mobile-notes-toggle"
            aria-label={detailPanelCollapsed ? "Show notes" : "Hide notes"}
            onClick={() => setDetailPanelCollapsed(!detailPanelCollapsed)}
          >
            Notes
          </button>
        </div>
      )}

      {isCompact && isMobileNavOpen && (
        <div
          className="mobile-scrim"
          onClick={() => setMobileNavOpen(false)}
          aria-hidden="true"
        />
      )}

      <Sidebar
        className={isCompact && isMobileNavOpen ? "sidebar-drawer-open" : undefined}
        onNewTerminal={handleNewTerminal}
        onNewTerminalInProject={handleNewTerminalInProject}
        onNewProject={handleNewProject}
        onDeleteProject={handleDeleteProject}
        onDeleteTerminal={handleDeleteTerminal}
        onMoveTerminal={handleMoveTerminal}
        style={isCompact ? undefined : { width: sidebarWidth, minWidth: sidebarWidth }}
      />
      {!isCompact && (
        <div
          ref={sidebarDividerRef}
          className="sidebar-divider"
          onMouseDown={handleSidebarDividerMouseDown}
        />
      )}
      <div className="main-content">
        {activeProject && activeLayoutKey ? (
          <ProjectView
            key={activeLayoutKey}
            layoutId={activeLayoutKey}
            onSplitPane={handleSplitPane}
            onClosePane={handleClosePane}
          />
        ) : (
          <div className="empty-view">
            <p>Create a project to get started</p>
          </div>
        )}
      </div>

      <PushSetupPrompt onRegister={handleRegisterPushSubscription} />
      {pushStatus && (
        <div className="push-status" role="status">
          {pushStatus}
        </div>
      )}
      {isCompact && <MobileKeyBar />}

      {dialog?.type === "new-project" && (
        <NameDialog
          title="New Project"
          placeholder="Project name"
          onConfirm={handleDialogConfirm}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.type === "new-project-with-terminal" && (
        <NameDialog
          title="New Project"
          placeholder="Project name"
          onConfirm={handleDialogConfirm}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.type === "new-terminal" && (
        <NameDialog
          title="New Terminal"
          placeholder="Terminal name"
          onConfirm={handleDialogConfirm}
          onCancel={() => setDialog(null)}
        />
      )}
      {showKeyDebug && <KeyDebugOverlay />}
    </div>
  );
}
