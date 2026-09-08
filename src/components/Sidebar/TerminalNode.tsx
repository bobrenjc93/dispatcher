import { useState, useRef, useEffect, useCallback } from "react";
import { StatusDot } from "../common/StatusDot";
import { ContextMenu, type ContextMenuItem } from "../common/ContextMenu";
import { useTerminalStore } from "../../stores/useTerminalStore";
import { useProjectStore } from "../../stores/useProjectStore";
import { useLayoutStore } from "../../stores/useLayoutStore";
import { useTabSelectionStore } from "../../stores/useTabSelectionStore";
import { findLayoutKeyForTerminal } from "../../lib/layoutUtils";
import { performAction } from "../../lib/replication";
import {
  classifyTabClick,
  commonValue,
  nextToggleValue,
  selectionTargets,
  visibleTabOrder,
} from "../../lib/tabSelection";
import type { TerminalSession } from "../../types/terminal";
import { shouldIgnoreDragStartTarget, startDrag } from "../../lib/dragState";
import { focusTerminalInstance } from "../../hooks/useTerminalBridge";
import { renameTmuxTerminal } from "../../lib/tmuxControl";
import { prepareInactionNotificationSound } from "../../lib/inactionNotification";
import {
  DEFAULT_SNOOZE_MS,
  formatSnoozeRemaining,
  isSnoozeActive,
  parseSnoozeMinutes,
} from "../../lib/snooze";
import {
  formatInactivityThreshold,
  parseInactivityThresholdSeconds,
  resolveInactivityThresholdMs,
} from "../../lib/inactivityThreshold";

interface TerminalNodeProps {
  terminalId: string;
  projectId: string;
  nodeId: string;
  parentNodeId: string;
  isActive: boolean;
  onClick: () => void;
  onDeleteTerminals: (terminalIds: string[]) => void;
}

/** Where a range starts when nothing has been selected yet. */
function activeTabTerminalId(): string | null {
  const activeTerminalId = useTerminalStore.getState().activeTerminalId;
  if (!activeTerminalId) {
    return null;
  }
  // The sidebar lists tabs, and the active terminal may be a pane inside one.
  return findLayoutKeyForTerminal(useLayoutStore.getState().layouts, activeTerminalId)
    ?? activeTerminalId;
}

function currentTabOrder(): string[] {
  const { projects, projectOrder, nodes } = useProjectStore.getState();
  return visibleTabOrder({
    projects,
    projectOrder,
    nodes,
    sessions: useTerminalStore.getState().sessions,
  });
}

export function TerminalNode({ terminalId, projectId, nodeId, parentNodeId, isActive, onClick, onDeleteTerminals }: TerminalNodeProps) {
  const session = useTerminalStore((s) => s.sessions[terminalId]);
  const updateTitle = useTerminalStore((s) => s.updateTitle);
  const patchSession = useTerminalStore((s) => s.patchSession);
  // A boolean rather than the list: every tab would re-render on every
  // selection change if it subscribed to the array.
  const isSelected = useTabSelectionStore((s) => s.terminalIds.includes(terminalId));
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  // The menu carries the tabs it was opened on. Deciding that once, when it
  // opens, is what makes the menu describe what it will actually do.
  const [menu, setMenu] = useState<{ x: number; y: number; targets: string[] } | null>(null);
  const [thresholdTargets, setThresholdTargets] = useState<string[] | null>(null);
  const [snoozeTargets, setSnoozeTargets] = useState<string[] | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const nodeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const startRename = useCallback(() => {
    if (session) {
      setDraft(session.title);
      setEditing(true);
    }
  }, [session]);

  // Listen for the global rename shortcut dispatched from App
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.terminalId === terminalId) {
        startRename();
      }
    };
    window.addEventListener("rename-terminal", handler);
    return () => window.removeEventListener("rename-terminal", handler);
  }, [terminalId, startRename]);

  if (!session) return null;

  const commitRename = () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== session.title) {
      void renameTmuxTerminal(terminalId, trimmed)
        .then((handled) => {
          if (!handled) {
            updateTitle(terminalId, trimmed);
          }
        })
        .catch(() => {
          updateTitle(terminalId, trimmed);
        });
    }
    const activeId = useTerminalStore.getState().activeTerminalId;
    if (activeId) {
      requestAnimationFrame(() => focusTerminalInstance(activeId));
    }
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (shouldIgnoreDragStartTarget(e.target)) return;
    // A modifier means the click is about selecting, not moving. Starting a
    // drag here would turn a shift-click into a reorder.
    if (e.shiftKey || e.metaKey || e.ctrlKey) return;
    startDrag({ type: "terminal", terminalId, projectId, nodeId }, e.clientX, e.clientY, e.currentTarget as HTMLElement, e.pointerType);
  };

  const handleClick = (e: React.MouseEvent) => {
    const kind = classifyTabClick(e, { isMac: navigator.platform.startsWith("Mac") });
    if (kind === "plain") {
      useTabSelectionStore.getState().clickTab({
        order: currentTabOrder(),
        terminalId,
        kind,
        fallbackAnchorTerminalId: activeTabTerminalId(),
      });
      onClick();
      return;
    }

    // Selecting is not visiting: a shift-click should not pull focus into a
    // tab you are only marking.
    e.preventDefault();
    e.stopPropagation();
    useTabSelectionStore.getState().clickTab({
      order: currentTabOrder(),
      terminalId,
      kind,
      fallbackAnchorTerminalId: activeTabTerminalId(),
    });
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const selection = useTabSelectionStore.getState();
    const targets = selectionTargets(selection, terminalId);
    if (selection.terminalIds.length > 0 && !selection.terminalIds.includes(terminalId)) {
      // Right-clicking outside the selection abandons it, rather than leaving
      // tabs highlighted that the menu is about to ignore. Guarded so that
      // right-clicking with nothing selected does not throw away the anchor a
      // later shift-click would measure from.
      useTabSelectionStore.getState().clear();
    }
    setMenu({ x: e.clientX, y: e.clientY, targets });
  };

  // Read once per render; the monitor clears the deadline when it lapses,
  // which is the re-render that makes this correct again.
  const snoozeActive = isSnoozeActive(session?.snoozedUntil, Date.now());

  const nodeClassName = [
    "sidebar-terminal-node",
    isActive ? "active" : "",
    isSelected ? "selected" : "",
    !session.isPinnedGray && (session.isNeedsAttention || session.isPinnedGreen)
      ? "needs-attention"
      : "",
  ].filter(Boolean).join(" ");

  const buildMenuItems = (targets: string[]): ContextMenuItem[] => {
    const sessions = useTerminalStore.getState().sessions;
    const targetSessions = targets
      .map((id) => sessions[id])
      .filter((value): value is TerminalSession => Boolean(value));
    const isBulk = targets.length > 1;
    // Say how many a menu item will touch. Without it "Delete" on a selection
    // of eight looks exactly like "Delete" on one.
    const withCount = (label: string) => (isBulk ? `${label} (${targets.length})` : label);
    const everyTarget = (read: (value: TerminalSession) => boolean) =>
      targetSessions.length > 0 && targetSessions.every(read);
    const toggleAcross = (
      read: (value: TerminalSession) => boolean,
      write: (value: boolean) => Partial<TerminalSession>,
      onEnable?: () => void
    ) => {
      const next = nextToggleValue(targetSessions.map(read));
      if (next) {
        onEnable?.();
      }
      for (const id of targets) {
        patchSession(id, write(next));
      }
    };

    const allSnoozed = everyTarget((value) => isSnoozeActive(value.snoozedUntil, Date.now()));
    const thresholds = targetSessions.map((value) => value.inactivityThresholdMs);
    const uniformThreshold = commonValue(thresholds);
    const thresholdsDisagree =
      uniformThreshold === undefined && thresholds.some((value) => value !== undefined);

    return [
      {
        label: withCount("Pin Green"),
        icon: (
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M5 2.25H9L8.5 5L10.75 7.25V8.25H3.25V7.25L5.5 5L5 2.25ZM7 8.25V12" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ),
        checked: everyTarget((value) => value.isPinnedGreen ?? false),
        onClick: () =>
          toggleAcross(
            (value) => value.isPinnedGreen ?? false,
            (value) => ({ isPinnedGreen: value })
          ),
      },
      {
        label: withCount("Pin Gray"),
        icon: (
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M5 2.25H9L8.5 5L10.75 7.25V8.25H3.25V7.25L5.5 5L5 2.25ZM7 8.25V12" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ),
        checked: everyTarget((value) => value.isPinnedGray ?? false),
        onClick: () =>
          toggleAcross(
            (value) => value.isPinnedGray ?? false,
            (value) => ({ isPinnedGray: value })
          ),
      },
      {
        label: withCount(allSnoozed ? "Wake" : "Snooze"),
        shortcut:
          allSnoozed && !isBulk
            ? formatSnoozeRemaining(session.snoozedUntil ?? 0, Date.now())
            : undefined,
        icon: (
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M11.5 8.6A5 5 0 0 1 5.4 2.5 4.75 4.75 0 1 0 11.5 8.6Z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ),
        onClick: () => {
          if (allSnoozed) {
            for (const id of targets) {
              patchSession(id, { snoozedUntil: undefined });
            }
            return;
          }
          setSnoozeTargets(targets);
        },
      },
      {
        label: withCount("Notify on Inactivity"),
        icon: (
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M3.25 9.75H10.75L9.75 8.25V6A2.75 2.75 0 0 0 4.25 6V8.25L3.25 9.75ZM5.75 11.25C5.95 11.65 6.35 11.9 7 11.9C7.65 11.9 8.05 11.65 8.25 11.25" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ),
        checked: everyTarget((value) => value.notifyOnInaction ?? false),
        onClick: () =>
          toggleAcross(
            (value) => value.notifyOnInaction ?? false,
            (value) => ({ notifyOnInaction: value }),
            prepareInactionNotificationSound
          ),
      },
      {
        label: withCount("Push on Inactivity"),
        icon: (
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <rect x="4" y="1.75" width="6" height="10.5" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
            <path d="M6.25 10.25H7.75" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        ),
        checked: everyTarget((value) => value.pushOnInaction ?? false),
        onClick: () =>
          toggleAcross(
            (value) => value.pushOnInaction ?? false,
            (value) => ({ pushOnInaction: value })
          ),
      },
      {
        label: withCount("Bounce on Inactivity"),
        icon: (
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M7 2.25V6.5M7 6.5L4.75 4.5M7 6.5L9.25 4.5M2.75 9.25C4.25 11 9.75 11 11.25 9.25" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ),
        checked: everyTarget((value) => value.bounceOnAttention ?? false),
        onClick: () =>
          toggleAcross(
            (value) => value.bounceOnAttention ?? false,
            (value) => ({ bounceOnAttention: value })
          ),
      },
      // One push to one phone. There is nothing useful about sending several
      // at once, so this stays a single-tab action.
      ...(isBulk
        ? []
        : [
            {
              label: "Send a Test Push",
              icon: (
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M12.25 1.75L6.5 7.5M12.25 1.75L8.5 12.25L6.5 7.5M12.25 1.75L1.75 5.5L6.5 7.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ),
              onClick: () => {
                // Relayed rather than called: only the desktop can reach a
                // push service, and this menu is usually being tapped on the
                // phone that is meant to receive the result.
                performAction("sendTestPush", terminalId, session.title);
              },
            },
          ]),
      {
        label: withCount("Inactivity Threshold"),
        // The current value goes in the shortcut slot rather than into
        // the label. Parenthesised after an ellipsis it read as clutter,
        // and this is the same right-aligned secondary column the other
        // items already use.
        shortcut: thresholdsDisagree ? "Mixed" : formatInactivityThreshold(uniformThreshold),
        icon: (
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <circle cx="7" cy="7" r="4.75" stroke="currentColor" strokeWidth="1.2" />
            <path d="M7 4.5V7L8.75 8.25" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ),
        onClick: () => setThresholdTargets(targets),
      },
      {
        label: withCount("Move to Top"),
        icon: (
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M7 11V3M4 6L7 3L10 6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        ),
        shortcut: isBulk ? undefined : "⌘U",
        onClick: () => {
          // Bottom-up, because each one lands above the last: promoting in
          // order would arrive reversed.
          for (const id of [...targets].reverse()) {
            useProjectStore.getState().promoteChild(id);
          }
        },
      },
      {
        label: withCount("Move to Bottom"),
        icon: (
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M7 3V11M4 8L7 11L10 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        ),
        shortcut: isBulk ? undefined : "⌘B",
        onClick: () => {
          for (const id of targets) {
            useProjectStore.getState().demoteChild(id);
          }
        },
      },
      // Renaming is per-tab by nature: several tabs cannot share one name.
      ...(isBulk
        ? []
        : [
            {
              label: "Rename",
              icon: (
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M8.5 2.5L11.5 5.5M2 12L2.5 9.5L10 2C10.5 1.5 11.5 1.5 12 2C12.5 2.5 12.5 3.5 12 4L4.5 11.5L2 12Z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              ),
              shortcut: "⌘R",
              onClick: startRename,
            },
          ]),
      {
        label: withCount("Delete"),
        icon: (
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M2.5 4H11.5M5 4V2.5H9V4M5.5 6.5V10.5M8.5 6.5V10.5M3.5 4L4 11.5H10L10.5 4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        ),
        onClick: () => onDeleteTerminals(targets),
        danger: true,
      },
    ];
  };

  return (
    <div
      ref={nodeRef}
      className={nodeClassName}
      data-node-id={nodeId}
      data-project-id={projectId}
      data-parent-node-id={parentNodeId}
      onClick={handleClick}
      onPointerDown={handlePointerDown}
      onContextMenu={handleContextMenu}
    >
      <StatusDot terminalId={terminalId} />
      {editing ? (
        <input
          ref={inputRef}
          className="sidebar-rename-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") setEditing(false);
            e.stopPropagation();
          }}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span
          className="terminal-node-title"
          onDoubleClick={(e) => {
            e.stopPropagation();
            startRename();
          }}
        >
          {session.title}
        </span>
      )}
      <button
        className="sidebar-delete-btn"
        onClick={(e) => {
          e.stopPropagation();
          onDeleteTerminals([terminalId]);
        }}
        title="Remove terminal"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M3 3L9 9M9 3L3 9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
        </svg>
      </button>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={buildMenuItems(menu.targets)}
        />
      )}
      {snoozeTargets && (
        <SnoozeDialog
          count={snoozeTargets.length}
          onCancel={() => setSnoozeTargets(null)}
          onSubmit={(until) => {
            for (const id of snoozeTargets) {
              patchSession(id, { snoozedUntil: until });
            }
            setSnoozeTargets(null);
          }}
        />
      )}
      {thresholdTargets && (
        <InactivityThresholdDialog
          currentMs={
            commonValue(
              thresholdTargets.map(
                (id) => useTerminalStore.getState().sessions[id]?.inactivityThresholdMs
              )
            )
          }
          count={thresholdTargets.length}
          onCancel={() => setThresholdTargets(null)}
          onSubmit={(value) => {
            for (const id of thresholdTargets) {
              patchSession(id, { inactivityThresholdMs: value });
            }
            setThresholdTargets(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * Editor for one tab's inactivity threshold.
 *
 * Seconds rather than milliseconds because that is the unit the setting is
 * thought about in, and an empty field is a real answer — go back to the
 * app-wide default — rather than a mistake to reject.
 */
function InactivityThresholdDialog(props: {
  currentMs: number | undefined;
  count: number;
  onSubmit: (value: number | undefined) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(
    props.currentMs === undefined
      ? ""
      : String(Math.round(resolveInactivityThresholdMs(props.currentMs) / 1000))
  );
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = () => {
    const parsed = parseInactivityThresholdSeconds(draft);
    if (!parsed.ok) {
      // Keep the dialog open rather than storing something the user did not
      // ask for; a silently corrected number is worse than being told.
      setError(parsed.reason);
      return;
    }
    props.onSubmit(parsed.value);
  };

  return (
    <div className="threshold-dialog-backdrop" role="presentation" onPointerDown={props.onCancel}>
      <div
        className="threshold-dialog"
        role="dialog"
        aria-label="Inactivity threshold"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <p className="threshold-dialog-hint">
          Seconds of no change before {props.count > 1 ? `each of these ${props.count} tabs` : "this tab"}
          {" "}counts as inactive. Leave empty for the default.
        </p>
        <input
          ref={inputRef}
          className="threshold-dialog-input"
          type="text"
          inputMode="numeric"
          placeholder={String(resolveInactivityThresholdMs(undefined) / 1000)}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              props.onCancel();
            }
          }}
        />
        {error && <p className="threshold-dialog-error">{error}</p>}
        <div className="threshold-dialog-actions">
          <button type="button" className="threshold-dialog-btn" onClick={props.onCancel}>
            Cancel
          </button>
          <button type="button" className="threshold-dialog-btn is-primary" onClick={submit}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * How long to hold a tab quiet.
 *
 * Minutes, because that is the unit the decision is made in — "give me half an
 * hour" rather than a clock time. Pre-filled with the default so the common
 * case is open, confirm.
 */
function SnoozeDialog(props: {
  count: number;
  onSubmit: (until: number) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(String(DEFAULT_SNOOZE_MS / 60_000));
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = () => {
    const parsed = parseSnoozeMinutes(draft, Date.now());
    if (!parsed.ok) {
      setError(parsed.reason);
      return;
    }
    props.onSubmit(parsed.until);
  };

  return (
    <div className="threshold-dialog-backdrop" role="presentation" onPointerDown={props.onCancel}>
      <div
        className="threshold-dialog"
        role="dialog"
        aria-label="Snooze"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <p className="threshold-dialog-hint">
          Minutes to keep {props.count > 1 ? `these ${props.count} tabs` : "this tab"} quiet.
          {props.count > 1 ? " They read" : " It reads"} as working and will not chime, push or
          bounce until the time is up.
        </p>
        <input
          ref={inputRef}
          className="threshold-dialog-input"
          type="text"
          inputMode="decimal"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              props.onCancel();
            }
          }}
        />
        {error && <p className="threshold-dialog-error">{error}</p>}
        <div className="threshold-dialog-actions">
          <button type="button" className="threshold-dialog-btn" onClick={props.onCancel}>
            Cancel
          </button>
          <button type="button" className="threshold-dialog-btn is-primary" onClick={submit}>
            Snooze
          </button>
        </div>
      </div>
    </div>
  );
}
