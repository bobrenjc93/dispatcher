import { useState, useRef, useEffect, useCallback } from "react";
import { StatusDot } from "../common/StatusDot";
import { ContextMenu } from "../common/ContextMenu";
import { useTerminalStore } from "../../stores/useTerminalStore";
import { startDrag } from "../../lib/dragState";

interface TerminalNodeProps {
  terminalId: string;
  projectId: string;
  nodeId: string;
  parentNodeId: string;
  isActive: boolean;
  onClick: () => void;
  onDelete: () => void;
}

export function TerminalNode({ terminalId, projectId, nodeId, parentNodeId, isActive, onClick, onDelete }: TerminalNodeProps) {
  const session = useTerminalStore((s) => s.sessions[terminalId]);
  const updateTitle = useTerminalStore((s) => s.updateTitle);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
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

  // Listen for Cmd+R rename shortcut dispatched from App
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
      updateTitle(terminalId, trimmed);
    }
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    startDrag({ type: "terminal", terminalId, projectId, nodeId }, e.clientX, e.clientY, e.currentTarget as HTMLElement);
  };

  return (
    <div
      ref={nodeRef}
      className={`sidebar-terminal-node ${isActive ? "active" : ""}`}
      data-node-id={nodeId}
      data-project-id={projectId}
      data-parent-node-id={parentNodeId}
      onClick={onClick}
      onPointerDown={handlePointerDown}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
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
          onDelete();
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
          items={[
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
            {
              label: "Delete",
              icon: (
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M2.5 4H11.5M5 4V2.5H9V4M5.5 6.5V10.5M8.5 6.5V10.5M3.5 4L4 11.5H10L10.5 4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              ),
              onClick: onDelete,
              danger: true,
            },
          ]}
        />
      )}
    </div>
  );
}
