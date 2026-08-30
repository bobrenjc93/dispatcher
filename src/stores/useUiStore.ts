import { create } from "zustand";
import { persist } from "zustand/middleware";
import { getScopedStorageKey } from "../lib/storageNamespace";

/**
 * How a terminal is sized on a narrow screen. The grid belongs to the desktop,
 * so a phone either shrinks the text until the whole grid fits, or keeps it
 * readable and pans sideways.
 */
export type CompactTerminalFit = "readable" | "fit-width";

/**
 * What a vertical swipe does on a narrow screen.
 *
 * Two things want that gesture. The grid can be taller than the phone, so the
 * box around it scrolls to move over the parts that do not fit; and xterm keeps
 * the scrollback in its own scroller *inside* that box. A touch gesture chains
 * outward, never inward, so whenever the outer box can scroll it takes the
 * swipe and the history underneath is unreachable. Rather than pick one, this
 * says which the swipe belongs to.
 *
 * Pan is the resting state and every tab opens on it, because scrolling
 * history hides the rows above the fold — worth it for the tab you are reading
 * back through, rarely what you want the moment a different tab appears.
 * Deliberately not persisted for the same reason.
 */
export type CompactTouchGesture = "history" | "pan";

interface UiStore {
  isTerminalNotesOpen: boolean;
  isDetailPanelCollapsed: boolean;
  compactTerminalFit: CompactTerminalFit;
  compactTouchGesture: CompactTouchGesture;
  /** On-screen Ctrl is armed; the next character becomes a control code. */
  isCtrlArmed: boolean;
  setCompactTerminalFit: (fit: CompactTerminalFit) => void;
  setCompactTouchGesture: (gesture: CompactTouchGesture) => void;
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
      compactTouchGesture: "pan",
      isCtrlArmed: false,
      setCompactTerminalFit: (fit) => set({ compactTerminalFit: fit }),
      setCompactTouchGesture: (gesture) => set({ compactTouchGesture: gesture }),
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
