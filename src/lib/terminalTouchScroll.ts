/**
 * One vertical axis for a terminal on a phone.
 *
 * Two things scroll vertically there. The grid is the desktop's, usually taller
 * than the screen, so the box around it scrolls to reach the rows below the
 * fold; and above the grid's first row sits xterm's scrollback, which moves
 * only through `scrollLines()`. They used to be separate gestures behind a
 * Pan / Scroll toggle, because a native swipe chains outward and could never
 * fall through from the box into the history inside it.
 *
 * Seen as one document they are a single column: the history lines, then the
 * grid. The line at the top of the screen is `viewportY + scrollTop / rowHeight`,
 * so a swipe only has to move that one number, and these functions decide how
 * to split it between the two scrollers.
 */
export interface VerticalScrollState {
  /** Buffer line on the grid's top row: xterm's `viewportY`. */
  viewportY: number;
  /** The newest `viewportY` can be: xterm's `baseY`. Zero on the alt screen. */
  baseY: number;
  /** The box around the grid. */
  scrollTop: number;
  maxScrollTop: number;
  rowHeightPx: number;
}

export interface VerticalScrollPlacement {
  viewportY: number;
  scrollTop: number;
  /** Where the request landed once held inside the document. */
  offsetPx: number;
  /** The request ran past the oldest line or the newest one. */
  atEdge: boolean;
}

/** How far down the whole column the top of the screen is, in pixels. */
export function verticalScrollOffset(state: VerticalScrollState): number {
  return state.viewportY * state.rowHeightPx + state.scrollTop;
}

/** The furthest down the column the top of the screen can be. */
export function maxVerticalScrollOffset(state: VerticalScrollState): number {
  return state.baseY * state.rowHeightPx + Math.max(0, state.maxScrollTop);
}

/**
 * Split a position in the column between xterm and the box.
 *
 * The box moves first and xterm only when the box cannot get there. That is
 * the difference between smooth and stepped: the box scrolls by the pixel and
 * on the compositor, while `scrollLines()` moves whole rows and repaints the
 * grid. Crossing into the history, the box gives back a row's worth of travel
 * for each line xterm takes, so the swipe keeps moving by the pixel there too
 * whenever the grid overflows the screen by at least a row.
 */
export function resolveVerticalScroll(
  state: VerticalScrollState,
  offsetPx: number
): VerticalScrollPlacement {
  const rowHeight = state.rowHeightPx;
  const maxScrollTop = Math.max(0, state.maxScrollTop);
  if (!(rowHeight > 0) || !Number.isFinite(offsetPx)) {
    return {
      viewportY: state.viewportY,
      scrollTop: state.scrollTop,
      offsetPx: verticalScrollOffset(state),
      atEdge: false,
    };
  }

  const max = maxVerticalScrollOffset(state);
  const offset = Math.min(max, Math.max(0, offsetPx));
  const atEdge = offset !== offsetPx;

  let viewportY = state.viewportY;
  const wanted = offset - viewportY * rowHeight;
  if (wanted < 0) {
    viewportY = Math.max(0, viewportY - Math.ceil(-wanted / rowHeight));
  } else if (wanted > maxScrollTop) {
    viewportY = Math.min(state.baseY, viewportY + Math.ceil((wanted - maxScrollTop) / rowHeight));
  }
  const scrollTop = Math.min(maxScrollTop, Math.max(0, offset - viewportY * rowHeight));

  return { viewportY, scrollTop, offsetPx: offset, atEdge };
}

/** How far back a release looks to judge how fast the finger was going. */
const RELEASE_VELOCITY_WINDOW_MS = 80;

/**
 * Finger speed at the moment it lifts.
 *
 * Taken over the last few samples rather than the last one: a single
 * touchmove's delta is noisy enough that a flick could be judged by whichever
 * sample happened to land last, and a finger that stopped before lifting
 * should leave no speed at all.
 */
export class TouchVelocityTracker {
  private samples: Array<{ x: number; y: number; at: number }> = [];

  reset(x: number, y: number, at: number) {
    this.samples = [{ x, y, at }];
  }

  add(x: number, y: number, at: number) {
    this.samples.push({ x, y, at });
    const cutoff = at - RELEASE_VELOCITY_WINDOW_MS;
    while (this.samples.length > 2 && this.samples[0].at < cutoff) {
      this.samples.shift();
    }
  }

  /** Pixels per millisecond, positive when the finger moves right or down. */
  velocity(now: number): { x: number; y: number } {
    const last = this.samples[this.samples.length - 1];
    if (!last || now - last.at > RELEASE_VELOCITY_WINDOW_MS) {
      return { x: 0, y: 0 };
    }
    const first = this.samples.find((sample) => last.at - sample.at <= RELEASE_VELOCITY_WINDOW_MS)
      ?? last;
    const elapsed = last.at - first.at;
    if (elapsed <= 0) {
      return { x: 0, y: 0 };
    }
    return { x: (last.x - first.x) / elapsed, y: (last.y - first.y) / elapsed };
  }
}
