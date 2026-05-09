import { useEffect } from "react";
import { debugLog } from "../lib/debugLog";
import { refreshAllTerminalFrontends } from "./useTerminalBridge";

const WAKE_HEARTBEAT_MS = 5_000;
const WAKE_DRIFT_RECOVERY_MS = 30_000;

function forceDocumentRepaint(reason: string) {
  const root = document.documentElement;
  root.dataset.dispatcherWakeRecovery = String(Date.now());
  void root.offsetHeight;
  window.dispatchEvent(new Event("resize"));
  window.requestAnimationFrame(() => {
    if (root.dataset.dispatcherWakeRecovery) {
      delete root.dataset.dispatcherWakeRecovery;
    }
  });
  debugLog("app.wake", "forced document repaint", { reason });
}

function recoverAfterWake(reason: string, driftMs?: number) {
  debugLog("app.wake", "recover", {
    reason,
    driftMs: driftMs ?? null,
    visibilityState: document.visibilityState,
    hasFocus: document.hasFocus(),
  });
  forceDocumentRepaint(reason);
  refreshAllTerminalFrontends(reason);
}

export function useWakeRecovery() {
  useEffect(() => {
    let lastTick = Date.now();

    const intervalId = window.setInterval(() => {
      const now = Date.now();
      const driftMs = now - lastTick - WAKE_HEARTBEAT_MS;
      lastTick = now;
      if (driftMs >= WAKE_DRIFT_RECOVERY_MS) {
        recoverAfterWake("timer-drift", driftMs);
      }
    }, WAKE_HEARTBEAT_MS);

    const handleVisibilityChange = () => {
      lastTick = Date.now();
      if (document.visibilityState === "visible") {
        recoverAfterWake("visibility-visible");
      }
    };
    const handleFocus = () => {
      lastTick = Date.now();
      recoverAfterWake("window-focus");
    };
    const handlePageShow = (event: PageTransitionEvent) => {
      lastTick = Date.now();
      recoverAfterWake(event.persisted ? "pageshow-bfcache" : "pageshow");
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleFocus);
    window.addEventListener("pageshow", handlePageShow);

    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("pageshow", handlePageShow);
    };
  }, []);
}
