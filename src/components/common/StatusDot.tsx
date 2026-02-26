import { useEffect, useRef, useState } from "react";

const GRAY = "#888888";
const GREEN = "#00c853";
const DURATION_MS = 5 * 60 * 1000; // 5 minutes

// Persist timestamps outside React so the animation
// survives component remounts (e.g. when projects are reordered).
const lastTypedAt = new Map<string, number>();

function lerpColor(t: number): string {
  const r = Math.round(0x88 + (0x00 - 0x88) * t);
  const g = Math.round(0x88 + (0xc8 - 0x88) * t);
  const b = Math.round(0x88 + (0x53 - 0x88) * t);
  return `rgb(${r},${g},${b})`;
}

export function StatusDot({ terminalId }: { terminalId: string }) {
  const [color, setColor] = useState(() => {
    const ts = lastTypedAt.get(terminalId);
    if (!ts) return GREEN;
    const t = Math.min((performance.now() - ts) / DURATION_MS, 1);
    return lerpColor(t);
  });
  const rafRef = useRef<number>(0);
  const animatingRef = useRef(false);

  useEffect(() => {
    function tick() {
      const start = lastTypedAt.get(terminalId);
      if (!start) {
        animatingRef.current = false;
        setColor(GREEN);
        return;
      }
      const elapsed = performance.now() - start;
      const t = Math.min(elapsed / DURATION_MS, 1);
      setColor(lerpColor(t));
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        animatingRef.current = false;
      }
    }

    function ensureAnimating() {
      if (animatingRef.current) return;
      animatingRef.current = true;
      rafRef.current = requestAnimationFrame(tick);
    }

    const handler = (e: Event) => {
      const id = (e as CustomEvent).detail;
      if (id !== terminalId) return;
      lastTypedAt.set(terminalId, performance.now());
      ensureAnimating();
    };

    window.addEventListener("terminal-typed", handler);

    // Resume animation if there's an existing timestamp that hasn't fully elapsed
    if (lastTypedAt.has(terminalId)) {
      ensureAnimating();
    }

    return () => {
      cancelAnimationFrame(rafRef.current);
      animatingRef.current = false;
      window.removeEventListener("terminal-typed", handler);
    };
  }, [terminalId]);

  return (
    <span
      className="status-dot"
      style={{ backgroundColor: color }}
    />
  );
}
