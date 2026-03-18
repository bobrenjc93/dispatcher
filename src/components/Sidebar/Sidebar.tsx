import { useState, useEffect, useRef } from "react";
import { useProjectStore } from "../../stores/useProjectStore";
import { useTerminalStore } from "../../stores/useTerminalStore";
import { ProjectNode } from "./ProjectNode";
import { ContextMenu } from "../common/ContextMenu";
import { HotkeyHelp } from "../common/HotkeyHelp";
import { FontSettings } from "../common/FontSettings";
import { SchemePicker } from "../common/SchemePicker";
import { registerDragCallbacks } from "../../lib/dragState";

interface SidebarProps {
  onNewTerminal: () => void;
  onNewTerminalInProject: (projectId: string) => void;
  onNewProject: () => void;
  onDeleteProject: (projectId: string) => void;
  onDeleteTerminal: (terminalId: string, projectId: string) => void;
  onMoveTerminal: (terminalId: string, fromProjectId: string, toProjectId: string) => void;
  style?: React.CSSProperties;
}

export function Sidebar({
  onNewTerminal,
  onNewTerminalInProject,
  onNewProject,
  onDeleteProject,
  onDeleteTerminal,
  onMoveTerminal,
  style,
}: SidebarProps) {
  const projects = useProjectStore((s) => s.projects);
  const projectOrder = useProjectStore((s) => s.projectOrder);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const setActiveProject = useProjectStore((s) => s.setActiveProject);
  const reorderProject = useProjectStore((s) => s.reorderProject);
  const reorderChild = useProjectStore((s) => s.reorderChild);
  const activeTerminalId = useTerminalStore((s) => s.activeTerminalId);
  const setActiveTerminal = useTerminalStore((s) => s.setActiveTerminal);

  const callbacksRef = useRef({ reorderProject, onMoveTerminal, reorderChild });
  callbacksRef.current = { reorderProject, onMoveTerminal, reorderChild };

  useEffect(() => {
    registerDragCallbacks({
      onReorderProject: (...args) => callbacksRef.current.reorderProject(...args),
      onMoveTerminal: (...args) => callbacksRef.current.onMoveTerminal(...args),
      onReorderChild: (...args) => callbacksRef.current.reorderChild(...args),
    });
  }, []);

  const [bgMenu, setBgMenu] = useState<{ x: number; y: number } | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [showFontSettings, setShowFontSettings] = useState(false);
  const [showSchemePicker, setShowSchemePicker] = useState(false);

  // Listen for the global toggle-scheme-picker event (fired by keyboard shortcut)
  useEffect(() => {
    const handler = () => setShowSchemePicker((v) => !v);
    window.addEventListener("toggle-scheme-picker", handler);
    return () => window.removeEventListener("toggle-scheme-picker", handler);
  }, []);

  const projectList = projectOrder.map((id) => projects[id]).filter(Boolean);

  const bgMenuItems = [
    ...(activeProjectId
      ? [
          {
            label: "New Terminal",
            icon: (
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M7 3V11M3 7H11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
              </svg>
            ),
            onClick: () => onNewTerminalInProject(activeProjectId),
            shortcut: "⌘T",
          },
        ]
      : []),
    {
      label: "New Project",
      shortcut: "⌘N",
      icon: (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M1.5 3.5C1.5 2.67 2.17 2 3 2H5.5L7 4H11C11.83 4 12.5 4.67 12.5 5.5V10.5C12.5 11.33 11.83 12 11 12H3C2.17 12 1.5 11.33 1.5 10.5V3.5Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
          <path d="M6.5 7V10M5 8.5H8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
        </svg>
      ),
      onClick: onNewProject,
    },
  ];

  return (
    <div className="sidebar" style={style}>
      <div className="sidebar-header">
        <div className="sidebar-title">
          <svg width="20" height="20" viewBox="0 0 1024 1024" fill="none">
            <rect x="100" y="100" width="824" height="824" rx="185" fill="#1a1a1a"/>
            <path d="M 248 380 L 472 512 L 248 644" stroke="#ededed" strokeWidth="68" strokeLinecap="round" strokeLinejoin="round"/>
            <line x1="556" y1="400" x2="720" y2="400" stroke="#ededed" strokeWidth="52" strokeLinecap="round"/>
            <line x1="556" y1="512" x2="776" y2="512" stroke="#ededed" strokeWidth="52" strokeLinecap="round"/>
            <line x1="556" y1="624" x2="720" y2="624" stroke="#ededed" strokeWidth="52" strokeLinecap="round"/>
          </svg>
          <span>DevDispatcher</span>
        </div>
        <div className="sidebar-actions">
          <button onClick={onNewProject} title="New Project (⌘N)">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M2 4.5C2 3.67 2.67 3 3.5 3H6L7.5 5H12.5C13.33 5 14 5.67 14 6.5V11.5C14 12.33 13.33 13 12.5 13H3.5C2.67 13 2 12.33 2 11.5V4.5Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
              <path d="M7 8V11M5.5 9.5H8.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
      </div>
      <div
        className="sidebar-content"
        onContextMenu={(e) => {
          e.preventDefault();
          setBgMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        {projectList.length === 0 && (
          <div className="sidebar-empty">
            <p>No projects yet</p>
          </div>
        )}
        {projectList.map((project) => (
          <ProjectNode
            key={project.id}
            project={project}
            isActive={project.id === activeProjectId}
            activeTerminalId={activeTerminalId}
            onSelect={() => setActiveProject(project.id)}
            onTerminalClick={(terminalId) => {
              setActiveProject(project.id);
              setActiveTerminal(terminalId);
            }}
            onDeleteProject={() => onDeleteProject(project.id)}
            onDeleteTerminal={(terminalId) => onDeleteTerminal(terminalId, project.id)}
            onNewTerminal={() => onNewTerminalInProject(project.id)}
          />
        ))}
      </div>
      <div className="sidebar-footer">
        <button className="sidebar-help-btn" onClick={() => setShowSchemePicker(true)} title="Color Scheme (⇧⌘T)">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <circle cx="5" cy="5.5" r="2.5" stroke="currentColor" strokeWidth="1.2"/>
            <circle cx="9" cy="5.5" r="2.5" stroke="currentColor" strokeWidth="1.2"/>
            <circle cx="7" cy="9" r="2.5" stroke="currentColor" strokeWidth="1.2"/>
          </svg>
        </button>
        <button className="sidebar-help-btn" onClick={() => setShowFontSettings(true)} title="Font Settings">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M7 1.5C4.1 1.5 1.73 3.53 1.5 6.3a5.5 5.5 0 1 0 10.73 1.7A5.5 5.5 0 0 0 7 1.5Z" stroke="currentColor" strokeWidth="1.2"/>
            <circle cx="7" cy="7" r="1.5" stroke="currentColor" strokeWidth="1.2"/>
            <path d="M7 1.5V3M7 11V12.5M1.5 7H3M11 7h1.5M2.87 3.17l1.06 1.06M9.77 10.07l1.06 1.06M11.13 3.17l-1.06 1.06M4.23 10.07l-1.06 1.06" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
          </svg>
        </button>
        <button className="sidebar-help-btn" onClick={() => setShowHelp(true)} title="Keyboard Shortcuts">
          ?
        </button>
      </div>
      {bgMenu && (
        <ContextMenu
          x={bgMenu.x}
          y={bgMenu.y}
          onClose={() => setBgMenu(null)}
          items={bgMenuItems}
        />
      )}
      {showHelp && <HotkeyHelp onClose={() => setShowHelp(false)} />}
      {showFontSettings && <FontSettings onClose={() => setShowFontSettings(false)} />}
      {showSchemePicker && <SchemePicker onClose={() => setShowSchemePicker(false)} />}
    </div>
  );
}
