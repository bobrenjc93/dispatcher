export interface TmuxWindowSizeFromPaneViewportArgs {
  viewportWidthPx: number;
  viewportHeightPx: number;
  cellWidthPx: number;
  cellHeightPx: number;
  activePaneCols: number;
  activePaneRows: number;
  totalWindowCols: number;
  totalWindowRows: number;
}

export function computeTmuxWindowSizeFromPaneViewport(
  args: TmuxWindowSizeFromPaneViewportArgs
): { cols: number; rows: number } | null {
  if (
    !Number.isFinite(args.viewportWidthPx)
    || !Number.isFinite(args.viewportHeightPx)
    || !Number.isFinite(args.cellWidthPx)
    || !Number.isFinite(args.cellHeightPx)
    || !Number.isFinite(args.activePaneCols)
    || !Number.isFinite(args.activePaneRows)
    || !Number.isFinite(args.totalWindowCols)
    || !Number.isFinite(args.totalWindowRows)
    || args.viewportWidthPx <= 0
    || args.viewportHeightPx <= 0
    || args.cellWidthPx <= 0
    || args.cellHeightPx <= 0
    || args.activePaneCols <= 0
    || args.activePaneRows <= 0
    || args.totalWindowCols <= 0
    || args.totalWindowRows <= 0
  ) {
    return null;
  }

  const inferredWindowWidthPx = args.viewportWidthPx * (args.totalWindowCols / args.activePaneCols);
  const inferredWindowHeightPx = args.viewportHeightPx * (args.totalWindowRows / args.activePaneRows);
  const cols = Math.max(2, Math.floor(inferredWindowWidthPx / args.cellWidthPx));
  const rows = Math.max(1, Math.floor(inferredWindowHeightPx / args.cellHeightPx));

  if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
    return null;
  }

  return { cols, rows };
}

/**
 * Smallest window worth telling tmux about.
 *
 * A container measures zero while it is hidden or has not been laid out yet,
 * and a ResizeObserver reports that as readily as a real size. Fed through the
 * usual arithmetic it floors to nothing and gets clamped to the minimum, so a
 * transient 0x0 became a genuine `refresh-client -C 2x1`: tmux reflowed the
 * pane to two columns and every line of its content was destroyed. Resizing
 * the window afterwards restores the grid but not the text.
 *
 * The clamp is the trap. Nothing this small is ever a real terminal, so the
 * only safe reading of it is that the measurement is not usable yet.
 */
export const MIN_TMUX_WINDOW_COLS = 20;
export const MIN_TMUX_WINDOW_ROWS = 4;

/** Whether a computed grid is a real window rather than a bad measurement. */
export function isUsableTmuxWindowSize(cols: number, rows: number): boolean {
  return (
    Number.isFinite(cols)
    && Number.isFinite(rows)
    && cols >= MIN_TMUX_WINDOW_COLS
    && rows >= MIN_TMUX_WINDOW_ROWS
  );
}
