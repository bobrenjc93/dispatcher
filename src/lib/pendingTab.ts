import { create } from "zustand";

/**
 * The tab a click has picked but the app has not switched to yet.
 *
 * Switching tabs is the most expensive thing a click does: the new tab's
 * panes mount, its terminal is re-attached and re-measured, and a tmux pane
 * redraws. All of that used to land in the same frame as the sidebar's
 * highlight, so the row stayed dark until it was done -- on a busy renderer,
 * long enough to look like the click had been missed. The row lights up from
 * this instead, first, and the switch follows once that has been painted.
 */
export const usePendingTabStore = create<{ terminalId: string | null }>()(() => ({
  terminalId: null,
}));

/** The tab whose switch is already scheduled; a stray release must not undo it. */
let committingTerminalId: string | null = null;

export function showPendingTab(terminalId: string) {
  usePendingTabStore.setState({ terminalId });
}

/** Drop the highlight, unless another tab has taken it or its switch is on the way. */
export function clearPendingTab(terminalId: string) {
  if (
    usePendingTabStore.getState().terminalId === terminalId
    && committingTerminalId !== terminalId
  ) {
    usePendingTabStore.setState({ terminalId: null });
  }
}

/**
 * Run something once the current frame has reached the screen.
 *
 * A frame callback runs just before the browser paints, so a task queued from
 * one runs just after it. A hidden page paints nothing and runs no frame
 * callbacks, so there is nothing to wait for.
 */
export function afterNextPaint(run: () => void) {
  if (typeof document === "undefined" || document.hidden) {
    run();
    return;
  }
  requestAnimationFrame(() => {
    setTimeout(run, 0);
  });
}

/** Light up a tab's row now, and switch to it once that is on screen. */
export function activateTabAfterPaint(terminalId: string, activate: () => void) {
  showPendingTab(terminalId);
  committingTerminalId = terminalId;
  afterNextPaint(() => {
    try {
      activate();
    } finally {
      if (committingTerminalId === terminalId) {
        committingTerminalId = null;
      }
      clearPendingTab(terminalId);
    }
  });
}
