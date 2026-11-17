/**
 * One finger for both panning a terminal and scrolling its history on a phone.
 *
 * Two things move under a finger there. The grid is the desktop's, usually
 * wider and taller than the screen, so the box around it scrolls to reach the
 * rest; and above the grid's first row sits xterm's scrollback, which moves
 * only through `scrollLines()`. They used to be separate gestures behind a
 * Pan / Scroll toggle, because a native swipe chains outward and can never fall
 * through from the box into the history inside it.
 *
 * Panning stays native. iOS runs it on its own thread, in step with the finger
 * whatever the page is doing, and nothing driven from script keeps up with
 * that: touches reach the page late and a scroll offset set from script lands a
 * frame after that. So script only takes the swipes the browser cannot do --
 * the ones that go into the history -- and leaves every other one alone.
 */

/**
 * Whether a swipe is for the history rather than for panning the grid.
 *
 * Decided on the first move, because that is the only one the browser lets the
 * page cancel: once it has started a native scroll, the rest of the gesture is
 * its.
 *
 * `dy` is the finger's travel, positive downwards -- pulling content down,
 * towards older output.
 */
export function shouldScrollHistory(args: {
  dx: number;
  dy: number;
  /** xterm's `viewportY`: the buffer line on the grid's top row. */
  viewportY: number;
  /** xterm's `baseY`: the newest `viewportY` can be. Zero on the alt screen. */
  baseY: number;
  /** The box around the grid. */
  scrollTop: number;
}): boolean {
  // Sideways is always a pan; nothing else wants that direction.
  if (Math.abs(args.dy) <= Math.abs(args.dx)) {
    return false;
  }
  // Already reading back: every vertical swipe stays in the history until it
  // comes back to the newest line.
  if (args.viewportY < args.baseY) {
    return true;
  }
  // Pulling down from the top of the grid runs on into what came before it.
  return args.dy > 0 && args.baseY > 0 && args.scrollTop <= 1;
}

/**
 * Turn a finger's travel into whole lines of scrollback.
 *
 * The remainder is carried between moves: a finger produces many small deltas,
 * and rounding each one on its own throws most of them away, so a slow drag
 * would move nothing at all.
 */
export function consumeTouchScrollLines(
  carryLines: number,
  deltaPx: number,
  cellHeightPx: number
): { lines: number; carryLines: number } {
  if (!Number.isFinite(deltaPx) || !(cellHeightPx > 0)) {
    return { lines: 0, carryLines };
  }

  const total = carryLines + deltaPx / cellHeightPx;
  const lines = Math.trunc(total);
  return { lines, carryLines: total - lines };
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

/** Furthest a finger can drift and still be tapping rather than swiping. */
export const TAP_SLOP_PX = 10;
/** Longer than this is a press, not a tap; the selection gesture starts at 450. */
export const TAP_MAX_MS = 400;
/**
 * How long after the content last moved a touch still counts as stopping it.
 * A finger put down on a coasting scroll is catching it, not asking to type.
 */
export const TAP_AFTER_SCROLL_MS = 300;

/**
 * Whether a touch on a terminal was meant as a tap -- the gesture that
 * focuses it and raises the keyboard.
 *
 * The browser decides a touch was a tap on movement alone, and generously:
 * catching a flick, a short swipe that never got far enough to scroll, or a
 * thumb resting while the other hand types all came out as taps, and each one
 * threw the keyboard up over the output being read.
 */
export function isDeliberateTap(args: {
  /** Furthest the finger got from where it landed. */
  movedPx: number;
  durationMs: number;
  /** From the content last moving to the finger landing; Infinity if never. */
  sinceScrollMs: number;
  /** The content moved while the finger was down. */
  scrolledDuringTouch: boolean;
  /** Most fingers down at once during the touch. */
  maxTouches: number;
  /** A selection was up when the finger landed, so the tap was to dismiss it. */
  dismissedSelection: boolean;
}): boolean {
  return args.maxTouches === 1
    && !args.dismissedSelection
    && !args.scrolledDuringTouch
    && args.movedPx <= TAP_SLOP_PX
    && args.durationMs <= TAP_MAX_MS
    && args.sinceScrollMs >= TAP_AFTER_SCROLL_MS;
}
