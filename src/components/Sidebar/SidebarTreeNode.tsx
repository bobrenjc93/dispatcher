import type { TreeNode } from "../../types/project";
import { TerminalNode } from "./TerminalNode";
import { GroupNode } from "./GroupNode";

interface SidebarTreeNodeProps {
  node: TreeNode;
  nodeId: string;
  parentNodeId: string;
  projectId: string;
  activeTerminalId: string | null;
  onTerminalClick: (terminalId: string) => void;
  onDeleteTerminals: (terminalIds: string[]) => void;
  depth: number;
}

export function SidebarTreeNode({
  node,
  nodeId,
  parentNodeId,
  projectId,
  activeTerminalId,
  onTerminalClick,
  onDeleteTerminals,
  depth,
}: SidebarTreeNodeProps) {
  if (node.hidden) {
    return null;
  }

  if (node.type === "terminal" && node.terminalId) {
    return (
      <div style={{ paddingLeft: `${depth * 12}px` }}>
        <TerminalNode
          terminalId={node.terminalId}
          projectId={projectId}
          nodeId={nodeId}
          parentNodeId={parentNodeId}
          isActive={activeTerminalId === node.terminalId}
          onClick={() => onTerminalClick(node.terminalId!)}
          onDeleteTerminals={onDeleteTerminals}
        />
      </div>
    );
  }

  if (node.type === "group") {
    return (
      <GroupNode
        node={node}
        nodeId={nodeId}
        projectId={projectId}
        activeTerminalId={activeTerminalId}
        onTerminalClick={onTerminalClick}
        onDeleteTerminals={onDeleteTerminals}
        depth={depth}
      />
    );
  }

  return null;
}
