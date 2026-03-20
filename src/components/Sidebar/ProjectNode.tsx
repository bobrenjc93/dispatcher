import { useState, useRef, useEffect, useCallback } from "react";
import { useProjectStore } from "../../stores/useProjectStore";
import { SidebarTreeNode } from "./SidebarTreeNode";
import { ContextMenu } from "../common/ContextMenu";
import { startDrag } from "../../lib/dragState";
import type { Project } from "../../types/project";

interface ProjectNodeProps {
  project: Project;
  isActive: boolean;
  activeTerminalId: string | null;
  onSelect: () => void;
  onTerminalClick: (terminalId: string) => void;
  onDeleteProject: () => void;
  onDeleteTerminal: (terminalId: string) => void;
  onNewTerminal: () => void;
}

export function ProjectNode({
  project,
  isActive,
  activeTerminalId,
  onSelect,
  onTerminalClick,
  onDeleteProject,
  onDeleteTerminal,
  onNewTerminal,
}: ProjectNodeProps) {
  const nodes = useProjectStore((s) => s.nodes);
  const toggleExpanded = useProjectStore((s) => s.toggleProjectExpanded);
  const renameProject = useProjectStore((s) => s.renameProject);
  const rootNode = nodes[project.rootGroupId];

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const startRename = useCallback(() => {
    setDraft(project.name);
    setEditing(true);
  }, [project.name]);

  const commitRename = () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== project.name) {
      renameProject(project.id, trimmed);
    }
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    startDrag({ type: "project", projectId: project.id }, e.clientX, e.clientY, e.currentTarget as HTMLElement);
  };

  return (
    <div
      className={`sidebar-project-node ${isActive ? "active" : ""}`}
      data-project-id={project.id}
    >
      <div
        ref={headerRef}
        className="sidebar-project-header"
        onPointerDown={handlePointerDown}
        onClick={onSelect}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        <span
          className="project-chevron"
          onClick={(e) => {
            e.stopPropagation();
            toggleExpanded(project.id);
          }}
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            style={{
              transform: project.expanded ? "rotate(90deg)" : "rotate(0deg)",
              transition: "transform 0.15s",
            }}
          >
            <path d="M3 1.5L7 5L3 8.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </span>
        {editing ? (
          <input
            ref={inputRef}
            className="sidebar-rename-input sidebar-rename-project"
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
            className="project-name"
            onDoubleClick={(e) => {
              e.stopPropagation();
              startRename();
            }}
          >
            {project.name}
          </span>
        )}
        <button
          className="sidebar-add-terminal-btn"
          onClick={(e) => {
            e.stopPropagation();
            onNewTerminal();
          }}
          title="New Terminal (⌘T)"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M8 3V13M3 8H13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </button>
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: "New Terminal",
              icon: (
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M7 3V11M3 7H11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                </svg>
              ),
              onClick: onNewTerminal,
            },
            {
              label: "Rename",
              icon: (
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M8.5 2.5L11.5 5.5M2 12L2.5 9.5L10 2C10.5 1.5 11.5 1.5 12 2C12.5 2.5 12.5 3.5 12 4L4.5 11.5L2 12Z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              ),
              onClick: startRename,
            },
            {
              label: "Delete",
              icon: (
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M2.5 4H11.5M5 4V2.5H9V4M5.5 6.5V10.5M8.5 6.5V10.5M3.5 4L4 11.5H10L10.5 4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              ),
              onClick: onDeleteProject,
              danger: true,
            },
          ]}
        />
      )}
      {project.expanded && rootNode && rootNode.children && (
        <div
          className="sidebar-project-children"
          data-project-id={project.id}
          data-terminal-list-parent-node-id={project.rootGroupId}
        >
          {rootNode.children.map((childId) => {
            const child = nodes[childId];
            if (!child) return null;
            return (
              <SidebarTreeNode
                key={childId}
                node={child}
                nodeId={childId}
                parentNodeId={project.rootGroupId}
                projectId={project.id}
                activeTerminalId={activeTerminalId}
                onTerminalClick={onTerminalClick}
                onDeleteTerminal={onDeleteTerminal}
                depth={1}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
