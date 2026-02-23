import { useEffect, useRef, useState } from "react";
import { useTerminalStore } from "../../stores/useTerminalStore";

const GRAY = "#888888";
const DURATION_MS = 5 * 60 * 1000; // 5 minutes

// Persist deactivation timestamps outside React so the animation
// survives component remounts (e.g. when projects are reordered).
const deactivatedAt = new Map<string, number>();

function lerpColor(t: number): string {
  const r = Math.round(0x88 + (0x00 - 0x88) * t);
  const g = Math.round(0x88 + (0xc8 - 0x88) * t);
  const b = Math.round(0x88 + (0x53 - 0x88) * t);
  return `rgb(${r},${g},${b})`;
}

export function StatusDot({ terminalId }: { terminalId: string }) {
  const activeTerminalId = useTerminalStore((s) => s.activeTerminalId);
  const isActive = activeTerminalId === terminalId;
  const [color, setColor] = useState(() => {
    if (isActive) return GRAY;
    const ts = deactivatedAt.get(terminalId);
    if (!ts) return GRAY;
    const t = Math.min((performance.now() - ts) / DURATION_MS, 1);
    return lerpColor(t);
  });
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (isActive) {
      cancelAnimationFrame(rafRef.current);
      deactivatedAt.delete(terminalId);
      setColor(GRAY);
      return;
    }

    // Record deactivation time if not already set
    if (!deactivatedAt.has(terminalId)) {
      deactivatedAt.set(terminalId, performance.now());
    }
    const start = deactivatedAt.get(terminalId)!;

    function tick() {
      const elapsed = performance.now() - start;
      const t = Math.min(elapsed / DURATION_MS, 1);
      setColor(lerpColor(t));
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      }
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [isActive, terminalId]);

  return (
    <span
      className="status-dot"
      style={{ backgroundColor: color }}
    />
  );
}
