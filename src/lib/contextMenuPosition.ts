/**
 * Keeping a context menu on the screen.
 *
 * The old rule was one line per axis: if the menu runs past the right edge,
 * flip it left; past the bottom, flip it up. That is fine on a desktop, where
 * a menu is a fraction of the window. On a phone the same menu is a dozen
 * two-line rows, taller than the space above the finger — so flipping it up
 * pushed its top off the screen and the first few items became unreachable.
 *
 * Flipping is still preferred, because a menu that covers what you pressed is
 * disorienting. But the result is clamped to the viewport, and a menu with
 * nowhere left to go is made to scroll rather than to overflow.
 */

/** Breathing room between the menu and the edge of the screen. */
const VIEWPORT_MARGIN = 8;

export interface ContextMenuPlacement {
  left: number;
  top: number;
  /** Null when the menu fits; a pixel height when it has to scroll. */
  maxHeight: number | null;
}

export function resolveContextMenuPlacement(args: {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  margin?: number;
}): ContextMenuPlacement {
  const margin = args.margin ?? VIEWPORT_MARGIN;
  const available = Math.max(0, args.viewportHeight - margin * 2);
  // A menu taller than the screen scrolls; everything below is then arranged
  // around the height it will actually take.
  const maxHeight = args.height > available ? available : null;
  const height = maxHeight ?? args.height;

  return {
    left: clamp(
      args.x + args.width > args.viewportWidth ? args.x - args.width : args.x,
      margin,
      args.viewportWidth - args.width - margin
    ),
    top: clamp(
      args.y + height > args.viewportHeight ? args.y - height : args.y,
      margin,
      args.viewportHeight - height - margin
    ),
    maxHeight,
  };
}

/**
 * Clamp, tolerating a range that has collapsed.
 *
 * When the menu is wider than the screen the upper bound falls below the
 * lower one; pinning to the lower bound keeps the near edge visible, which is
 * the half worth seeing.
 */
function clamp(value: number, low: number, high: number): number {
  if (high < low) {
    return low;
  }
  return Math.min(Math.max(value, low), high);
}
