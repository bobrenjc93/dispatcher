import { useEffect } from "react";
import { computeAppViewportHeight, isSignificantViewportChange } from "../lib/softKeyboard";

/**
 * Keeps the app sized to the visual viewport and the terminal pinned to the
 * bottom while the soft keyboard opens and closes.
 *
 * Only runs on a narrow screen. On a desktop the visual viewport tracks the
 * window and there is no keyboard to make room for.
 */
export function useSoftKeyboardViewport(isCompact: boolean, onViewportChange: () => void) {
  useEffect(() => {
    if (!isCompact || typeof window === "undefined") {
      return;
    }

    const visual = window.visualViewport ?? null;
    let lastHeight = -1;

    const apply = () => {
      const height = computeAppViewportHeight(
        visual ? { height: visual.height, offsetTop: visual.offsetTop } : null,
        window.innerHeight
      );
      if (!isSignificantViewportChange(lastHeight, height)) {
        return;
      }
      lastHeight = height;
      // Consumed by the compact layout, which uses it instead of 100dvh so the
      // terminal stops where the keyboard starts.
      document.documentElement.style.setProperty("--app-viewport-height", `${height}px`);
      onViewportChange();
    };

    apply();
    visual?.addEventListener("resize", apply);
    visual?.addEventListener("scroll", apply);
    window.addEventListener("orientationchange", apply);

    return () => {
      visual?.removeEventListener("resize", apply);
      visual?.removeEventListener("scroll", apply);
      window.removeEventListener("orientationchange", apply);
      document.documentElement.style.removeProperty("--app-viewport-height");
    };
  }, [isCompact, onViewportChange]);
}
