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
  /**
   * How far the terminal has been pinched on a narrow screen, on top of the
   * fit. 1 is the fit as chosen. Picking a fit starts it over, since the
   * point of picking one is to see the grid that way.
   */
  compactTerminalZoom: number;
  /** On-screen Ctrl is armed; the next character becomes a control code. */
  setCompactTerminalFit: (fit: CompactTerminalFit) => void;
  setCompactTerminalZoom: (zoom: number) => void;
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
      compactTerminalZoom: 1,
      setCompactTerminalFit: (fit) => set({ compactTerminalFit: fit, compactTerminalZoom: 1 }),
      setCompactTerminalZoom: (zoom) => set({ compactTerminalZoom: zoom }),
      // Deliberately left out of partialize: a modifier armed yesterday should
      // not still be armed today.
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
        compactTerminalZoom: state.compactTerminalZoom,
      }),
    }
  )
);
