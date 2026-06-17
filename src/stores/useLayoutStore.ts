import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { LayoutNode } from "../types/layout";
import {
  createLeaf,
  splitAtTerminal,
  removeFromLayout,
  updateRatio,
} from "../lib/layoutUtils";
import { getScopedStorageKey } from "../lib/storageNamespace";

interface LayoutStore {
  layouts: Record<string, LayoutNode>;

  initLayout: (layoutId: string, terminalId: string) => void;
  splitTerminal: (
    layoutId: string,
    targetTerminalId: string,
    newTerminalId: string,
    direction: "horizontal" | "vertical"
  ) => void;
  removeTerminal: (layoutId: string, targetTerminalId: string) => void;
  setRatio: (layoutId: string, splitId: string, ratio: number) => void;
  removeLayout: (layoutId: string) => void;
  getLayout: (layoutId: string) => LayoutNode | undefined;
}

export const useLayoutStore = create<LayoutStore>()(
  persist(
    (set, get) => ({
      layouts: {},

      initLayout: (layoutId, terminalId) =>
        set((state) => ({
          layouts: { ...state.layouts, [layoutId]: createLeaf(terminalId) },
        })),

      splitTerminal: (layoutId, targetTerminalId, newTerminalId, direction) =>
        set((state) => {
          const layout = state.layouts[layoutId];
          if (!layout) return state;
          return {
            layouts: {
              ...state.layouts,
              [layoutId]: splitAtTerminal(layout, targetTerminalId, newTerminalId, direction),
            },
          };
        }),

      removeTerminal: (layoutId, targetTerminalId) =>
        set((state) => {
          const layout = state.layouts[layoutId];
          if (!layout) return state;
          const newLayout = removeFromLayout(layout, targetTerminalId);
          if (!newLayout) {
            const { [layoutId]: _, ...rest } = state.layouts;
            return { layouts: rest };
          }
          return { layouts: { ...state.layouts, [layoutId]: newLayout } };
        }),

      setRatio: (layoutId, splitId, ratio) =>
        set((state) => {
          const layout = state.layouts[layoutId];
          if (!layout) return state;
          return {
            layouts: { ...state.layouts, [layoutId]: updateRatio(layout, splitId, ratio) },
          };
        }),

      removeLayout: (layoutId) =>
        set((state) => {
          const { [layoutId]: _, ...rest } = state.layouts;
          return { layouts: rest };
        }),

      getLayout: (layoutId) => get().layouts[layoutId],
    }),
    {
      name: getScopedStorageKey("dispatcher-layouts"),
    }
  )
);
