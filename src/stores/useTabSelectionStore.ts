import { create } from "zustand";
import {
  EMPTY_TAB_SELECTION,
  applyTabClick,
  type TabClickKind,
  type TabSelection,
} from "../lib/tabSelection";

/**
 * Which tabs are selected for a bulk action.
 *
 * Deliberately not persisted and deliberately not replicated. A selection is
 * about what you are doing right now on this screen: restoring yesterday's
 * would be a trap, and mirroring one phone's selection onto the desktop would
 * make a bulk action on either device act on the other's idea of "these".
 */
interface TabSelectionStore extends TabSelection {
  clickTab: (args: {
    order: readonly string[];
    terminalId: string;
    kind: TabClickKind;
    fallbackAnchorTerminalId: string | null;
  }) => void;
  clear: () => void;
  /**
   * Forget where the next range starts, without dropping the selection.
   *
   * Called when the active tab changes by some other means — the ⇧⌘[ and ⇧⌘]
   * shortcuts, a tapped notification, a replica switching tabs. Keeping the
   * old anchor would measure the next shift-click from wherever you last
   * clicked rather than from where you actually are, which is a range nobody
   * asked for. With it gone, the active tab takes over as the starting point.
   */
  releaseAnchor: () => void;
  /** Drop tabs that no longer exist, so a closed tab cannot stay selected. */
  prune: (validTerminalIds: readonly string[]) => void;
}

export const useTabSelectionStore = create<TabSelectionStore>()((set) => ({
  ...EMPTY_TAB_SELECTION,

  clickTab: ({ order, terminalId, kind, fallbackAnchorTerminalId }) =>
    set((state) =>
      applyTabClick({
        selection: { terminalIds: state.terminalIds, anchorTerminalId: state.anchorTerminalId },
        order,
        terminalId,
        kind,
        fallbackAnchorTerminalId,
      })
    ),

  clear: () => set(EMPTY_TAB_SELECTION),

  releaseAnchor: () =>
    set((state) => (state.anchorTerminalId === null ? state : { anchorTerminalId: null })),

  prune: (validTerminalIds) =>
    set((state) => {
      const valid = new Set(validTerminalIds);
      const terminalIds = state.terminalIds.filter((id) => valid.has(id));
      const anchorTerminalId =
        state.anchorTerminalId && valid.has(state.anchorTerminalId)
          ? state.anchorTerminalId
          : null;
      if (
        terminalIds.length === state.terminalIds.length
        && anchorTerminalId === state.anchorTerminalId
      ) {
        // Same set: returning a fresh array would re-render every tab on every
        // sidebar change.
        return state;
      }
      return { terminalIds, anchorTerminalId };
    }),
}));
