import { create } from "zustand";
import { persist } from "zustand/middleware";
import { getScopedStorageKey } from "../lib/storageNamespace";

/**
 * How a terminal is sized on a narrow screen. The grid belongs to the desktop,
 * so a phone either shrinks the text until the whole grid fits, or keeps it
 * readable and pans sideways.
 */
export type CompactTerminalFit = "readable" | "fit-width";

interface UiStore {
  isTerminalNotesOpen: boolean;
  isDetailPanelCollapsed: boolean;
  compactTerminalFit: CompactTerminalFit;
  /** On-screen Ctrl is armed; the next character becomes a control code. */
  isCtrlArmed: boolean;
  setCompactTerminalFit: (fit: CompactTerminalFit) => void;
  setCtrlArmed: (armed: boolean) => void;
  setTerminalNotesOpen: (isOpen: boolean) => void;
  setDetailPanelCollapsed: (isCollapsed: boolean) => void;
  toggleTerminalNotesOpen: () => void;
  toggleDetailPanelCollapsed: () => void;
}

export const useUiStore = create<UiStore>()(
  persist(
    (set) => ({
      isTerminalNotesOpen: false,
      isDetailPanelCollapsed: false,
      compactTerminalFit: "readable",
      isCtrlArmed: false,
      setCompactTerminalFit: (fit) => set({ compactTerminalFit: fit }),
      // Deliberately left out of partialize: a modifier armed yesterday should
      // not still be armed today.
      setCtrlArmed: (armed) => set({ isCtrlArmed: armed }),
      setTerminalNotesOpen: (isOpen) => set({ isTerminalNotesOpen: isOpen }),
      setDetailPanelCollapsed: (isCollapsed) => set({ isDetailPanelCollapsed: isCollapsed }),
      toggleTerminalNotesOpen: () =>
        set((state) => ({ isTerminalNotesOpen: !state.isTerminalNotesOpen })),
      toggleDetailPanelCollapsed: () =>
        set((state) => ({ isDetailPanelCollapsed: !state.isDetailPanelCollapsed })),
    }),
    {
      name: getScopedStorageKey("dispatcher-ui"),
      partialize: (state) => ({
        isTerminalNotesOpen: state.isTerminalNotesOpen,
        isDetailPanelCollapsed: state.isDetailPanelCollapsed,
        compactTerminalFit: state.compactTerminalFit,
      }),
    }
  )
);
