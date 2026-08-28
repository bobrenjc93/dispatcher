import { useEffect, useState } from "react";

/**
 * Below this width the three-column desktop layout (sidebar, notes, terminal)
 * stops fitting and the UI switches to a single column with the sidebar as a
 * drawer. Roughly a phone in portrait, or a narrow split-screen window.
 */
export const COMPACT_VIEWPORT_QUERY = "(max-width: 820px)";

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
