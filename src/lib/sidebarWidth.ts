/**
 * How wide the sidebar is allowed to get.
 *
 * The old ceiling was a flat 480px, which is a reasonable sidebar and a poor
 * limit: on a large display it is a small fraction of the window, and long tab
 * titles — a branch name, a PR URL — stay truncated with plenty of room going
 * spare. The useful bound is a share of the window rather than a fixed number.
 *
 * Half is the far end deliberately. Past it the sidebar is the main content
 * and the terminal is the panel, which is a different app.
 */
export const MIN_SIDEBAR_WIDTH = 160;
export const MAX_SIDEBAR_FRACTION = 0.5;

/**
 * The widest the sidebar may be for a given window.
 *
 * Never narrower than the minimum: on a window small enough that half of it is
 * under 160px, a max below the min would invert the clamp and pin the sidebar
 * to whichever bound was applied last.
 */
export function maxSidebarWidth(windowWidthPx: number): number {
  if (!Number.isFinite(windowWidthPx) || windowWidthPx <= 0) {
    return MIN_SIDEBAR_WIDTH;
  }
  return Math.max(MIN_SIDEBAR_WIDTH, Math.floor(windowWidthPx * MAX_SIDEBAR_FRACTION));
}

/** Bring a width inside the bounds for the current window. */
export function clampSidebarWidth(widthPx: number, windowWidthPx: number): number {
  const max = maxSidebarWidth(windowWidthPx);
  if (!Number.isFinite(widthPx)) {
    return MIN_SIDEBAR_WIDTH;
  }
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(max, Math.round(widthPx)));
}
