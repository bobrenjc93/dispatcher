import { useEffect, useState } from "react";

/**
 * When to drop the three-column desktop layout (sidebar, notes, terminal) for a
 * single column with the sidebar as a drawer.
 *
 * Width alone is not enough. Turning a phone to landscape makes it *wider* than
 * the breakpoint — an iPhone 15 goes from 393px to 852px — so the desktop
 * layout came back on a screen 393px tall, which fits it far worse than the
 * portrait one that qualified. What actually matters there is the short edge,
 * so a touch device with a short viewport is compact whatever its width.
 *
 * The touch conditions are load-bearing: `hover: none` and `pointer: coarse`
 * together mean a phone or tablet rather than a mouse, so an ordinary desktop
 * window that happens to be short keeps the desktop layout. And 500px sits in
 * clear air between a phone in landscape (≤430px tall) and a tablet in
 * landscape (≥744px), which should stay on the desktop layout.
 *
 * Kept in sync by hand with the `@media` block in App.css — there is no way to
 * share a value between the two, so changing one means changing the other.
 */
export const COMPACT_VIEWPORT_QUERY =
  "(max-width: 820px), (hover: none) and (pointer: coarse) and (max-height: 500px)";

function matchesCompactViewport(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(COMPACT_VIEWPORT_QUERY).matches;
}

/** True on a narrow screen. Updates on resize and device rotation. */
export function useCompactViewport(): boolean {
  const [isCompact, setIsCompact] = useState(matchesCompactViewport);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const query = window.matchMedia(COMPACT_VIEWPORT_QUERY);
    const update = () => setIsCompact(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return isCompact;
}

export function isCompactViewport(): boolean {
  return matchesCompactViewport();
}
