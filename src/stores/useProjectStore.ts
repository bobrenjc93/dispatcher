import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Project, TreeNode } from "../types/project";

interface ProjectStore {
  projects: Record<string, Project>;
  nodes: Record<string, TreeNode>;
  activeProjectId: string | null;
  projectOrder: string[];

  addProject: (project: Project) => void;
  removeProject: (id: string) => void;
  renameProject: (id: string, name: string) => void;
  setActiveProject: (id: string) => void;
  toggleProjectExpanded: (id: string) => void;
  reorderProject: (projectId: string, targetProjectId: string, position: "before" | "after") => void;
  reorderChild: (parentNodeId: string, childId: string, targetChildId: string, position: "before" | "after") => void;
  promoteChild: (terminalId: string) => void;

  addNode: (node: TreeNode) => void;
  removeNode: (id: string) => void;
  updateNodeName: (id: string, name: string) => void;
  updateNodeDescription: (id: string, description: string) => void;
  addChildToNode: (parentId: string, childId: string) => void;
  removeChildFromNode: (parentId: string, childId: string) => void;
  moveNode: (nodeId: string, newParentId: string) => void;
}

export const useProjectStore = create<ProjectStore>()(
  persist(
    (set) => ({
      projects: {},
      nodes: {},
      activeProjectId: null,
      projectOrder: [],

      addProject: (project) =>
        set((state) => ({
          projects: { ...state.projects, [project.id]: project },
          activeProjectId: state.activeProjectId ?? project.id,
          projectOrder: [...state.projectOrder, project.id],
        })),

      removeProject: (id) =>
        set((state) => {
          const { [id]: _, ...rest } = state.projects;
          const newOrder = state.projectOrder.filter((pid) => pid !== id);
          return {
            projects: rest,
            projectOrder: newOrder,
            activeProjectId:
              state.activeProjectId === id ? newOrder[0] ?? null : state.activeProjectId,
          };
        }),

      renameProject: (id, name) =>
        set((state) => {
          const project = state.projects[id];
          if (!project) return state;
          return {
            projects: { ...state.projects, [id]: { ...project, name } },
          };
        }),

      setActiveProject: (id) => set({ activeProjectId: id }),

      toggleProjectExpanded: (id) =>
        set((state) => {
          const project = state.projects[id];
          if (!project) return state;
          return {
            projects: {
              ...state.projects,
              [id]: { ...project, expanded: !project.expanded },
            },
          };
        }),

      reorderProject: (projectId, targetProjectId, position) =>
        set((state) => {
          if (projectId === targetProjectId) return state;
          const order = state.projectOrder.filter((id) => id !== projectId);
          const targetIdx = order.indexOf(targetProjectId);
          if (targetIdx === -1) return state;
          const insertIdx = position === "before" ? targetIdx : targetIdx + 1;
          order.splice(insertIdx, 0, projectId);
          return { projectOrder: order };
        }),

      reorderChild: (parentNodeId, childId, targetChildId, position) =>
        set((state) => {
          if (childId === targetChildId) return state;
          const parent = state.nodes[parentNodeId];
          if (!parent) return state;
          const children = (parent.children ?? []).filter((c) => c !== childId);
          const targetIdx = children.indexOf(targetChildId);
          if (targetIdx === -1) return state;
          const insertIdx = position === "before" ? targetIdx : targetIdx + 1;
          children.splice(insertIdx, 0, childId);
          return {
            nodes: {
              ...state.nodes,
              [parentNodeId]: { ...parent, children },
            },
          };
        }),

      promoteChild: (terminalId) =>
        set((state) => {
          const nodeEntry = Object.entries(state.nodes).find(
            ([, node]) => node.type === "terminal" && node.terminalId === terminalId
          );
          if (!nodeEntry) return state;
          const [nodeId, node] = nodeEntry;
          if (!node.parentId) return state;
          const parent = state.nodes[node.parentId];
          if (!parent?.children) return state;
          if (parent.children[0] === nodeId) return state;
          const children = parent.children.filter((c) => c !== nodeId);
          return {
            nodes: {
              ...state.nodes,
              [node.parentId]: { ...parent, children: [nodeId, ...children] },
            },
          };
        }),

      addNode: (node) =>
        set((state) => ({
          nodes: { ...state.nodes, [node.id]: node },
        })),

      removeNode: (id) =>
        set((state) => {
          const { [id]: _, ...rest } = state.nodes;
          return { nodes: rest };
        }),

      updateNodeName: (id, name) =>
        set((state) => {
          const node = state.nodes[id];
          if (!node) return state;
          return { nodes: { ...state.nodes, [id]: { ...node, name } } };
        }),

      updateNodeDescription: (id, description) =>
        set((state) => {
          const node = state.nodes[id];
          if (!node) return state;
          return { nodes: { ...state.nodes, [id]: { ...node, description } } };
        }),

      addChildToNode: (parentId, childId) =>
        set((state) => {
          const parent = state.nodes[parentId];
          if (!parent) return state;
          const children = parent.children ?? [];
          if (children.includes(childId)) return state;
          return {
            nodes: {
              ...state.nodes,
              [parentId]: { ...parent, children: [...children, childId] },
            },
          };
        }),

      removeChildFromNode: (parentId, childId) =>
        set((state) => {
          const parent = state.nodes[parentId];
          if (!parent) return state;
          return {
            nodes: {
              ...state.nodes,
              [parentId]: {
                ...parent,
                children: (parent.children ?? []).filter((c) => c !== childId),
              },
            },
          };
        }),

      moveNode: (nodeId, newParentId) =>
        set((state) => {
          const node = state.nodes[nodeId];
          if (!node) return state;

          let newNodes = { ...state.nodes };

          if (node.parentId && newNodes[node.parentId]) {
            const oldParent = newNodes[node.parentId];
            newNodes[node.parentId] = {
              ...oldParent,
              children: (oldParent.children ?? []).filter((c) => c !== nodeId),
            };
          }

          const newParent = newNodes[newParentId];
          if (newParent) {
            newNodes[newParentId] = {
              ...newParent,
              children: [...(newParent.children ?? []), nodeId],
            };
          }

          newNodes[nodeId] = { ...node, parentId: newParentId };

          return { nodes: newNodes };
        }),
    }),
    {
      name: "dispatcher-projects",
      merge: (persisted, current) => {
        const merged = { ...current, ...(persisted as Partial<ProjectStore>) };
        if (!merged.projectOrder || merged.projectOrder.length === 0) {
          merged.projectOrder = Object.keys(merged.projects);
        }
        return merged;
      },
    }
  )
);
