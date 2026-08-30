import { create } from "zustand";

/**
 * Which terminals a replica has been sent content for.
 *
 * A replica starts empty and is filled in by the desktop: it renders nothing at
 * all until the first mirror frame for a terminal arrives, and on a phone over
 * a slow link that wait is long enough to read as a broken tab rather than as
 * one still loading. Tracking arrival is what lets the UI say which it is.
 *
 * Client-local and deliberately not part of the workspace document — it
 * describes what this client has received, not anything about the session.
 */
interface MirrorHydrationStore {
  hydratedTerminalIds: ReadonlySet<string>;
  markTerminalHydrated: (terminalId: string) => void;
  forgetTerminalHydration: (terminalId: string) => void;
}

export const useMirrorHydrationStore = create<MirrorHydrationStore>()((set) => ({
  hydratedTerminalIds: new Set<string>(),
  markTerminalHydrated: (terminalId) =>
    set((state) => {
      if (state.hydratedTerminalIds.has(terminalId)) {
        // Output arrives constantly; replacing the set on every frame would
        // re-render every subscriber for no change.
        return state;
      }
      const next = new Set(state.hydratedTerminalIds);
      next.add(terminalId);
      return { hydratedTerminalIds: next };
    }),
  forgetTerminalHydration: (terminalId) =>
    set((state) => {
      if (!state.hydratedTerminalIds.has(terminalId)) {
        return state;
      }
      const next = new Set(state.hydratedTerminalIds);
      next.delete(terminalId);
      return { hydratedTerminalIds: next };
    }),
}));
