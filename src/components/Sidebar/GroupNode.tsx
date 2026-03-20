import { useState } from "react";
import { useProjectStore } from "../../stores/useProjectStore";
import { SidebarTreeNode } from "./SidebarTreeNode";
import type { TreeNode } from "../../types/project";

interface GroupNodeProps {
  node: TreeNode;
  nodeId: string;
  projectId: string;
  activeTerminalId: string | null;
  onTerminalClick: (terminalId: string) => void;
  onDeleteTerminal: (terminalId: string) => void;
  depth: number;
}

export function GroupNode({
  node,
  nodeId,
  projectId,
  activeTerminalId,
  onTerminalClick,
  onDeleteTerminal,
  depth,
}: GroupNodeProps) {
  const [expanded, setExpanded] = useState(true);
  const nodes = useProjectStore((s) => s.nodes);

  return (
    <div className="sidebar-group-node">
      <div
        className="sidebar-group-header"
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={() => setExpanded(!expanded)}
      >
        <span className="group-chevron">
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            style={{
              transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
              transition: "transform 0.15s",
            }}
          >
            <path d="M3 1.5L7 5L3 8.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </span>
        <span className="group-name">{node.name}</span>
      </div>
      {expanded && node.children && (
        <div
          className="sidebar-group-children"
          data-project-id={projectId}
          data-terminal-list-parent-node-id={nodeId}
        >
          {node.children.map((childId) => {
            const child = nodes[childId];
            if (!child) return null;
            return (
              <SidebarTreeNode
                key={childId}
                node={child}
                nodeId={childId}
                parentNodeId={nodeId}
                projectId={projectId}
                activeTerminalId={activeTerminalId}
                onTerminalClick={onTerminalClick}
                onDeleteTerminal={onDeleteTerminal}
                depth={depth + 1}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
