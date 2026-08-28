/**
 * Keeping a phone usable while the soft keyboard is up.
 *
 * A soft keyboard does not resize the window; it shrinks the *visual*
 * viewport and leaves the layout viewport alone. So a full-height terminal
 * keeps its height, the browser scrolls the page to reveal the focused
 * element, and the prompt ends up behind the keyboard — which is why tapping
 * into a terminal used to mean scrolling again afterwards.
 *
 * The fix is to size the app to the visual viewport instead of the window, and
 * to re-pin the terminal to the bottom whenever that viewport changes.
 */

/** Height the app should occupy, in CSS pixels. */
export function computeAppViewportHeight(
  visual: { height: number; offsetTop: number } | null,
  innerHeight: number
): number {
  if (!visual || !Number.isFinite(visual.height) || visual.height <= 0) {
    return innerHeight;
  }
  // offsetTop is non-zero when the page itself has been scrolled up to reveal
  // the focused element; that part of the window is off screen, so it is not
  // ours to draw in.
  const usable = visual.height - Math.max(0, visual.offsetTop);
  if (usable <= 0) {
    return innerHeight;
  }
  // Never grow beyond the window: some browsers briefly report a taller visual
  // viewport mid-animation, and growing past the window causes a bounce.
  return Math.min(usable, innerHeight);
}

/**
 * Whether a viewport change is worth reacting to.
 *
 * The visual viewport fires continuously while the keyboard animates, and each
 * reaction refits the terminal and re-pins its scroll. Ignoring sub-pixel
 * noise keeps that from running dozens of times per keystroke.
 */
export function isSignificantViewportChange(previous: number, next: number): boolean {
  return Math.abs(previous - next) >= 1;
}
