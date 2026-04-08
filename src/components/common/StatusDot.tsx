import { useTerminalStore } from "../../stores/useTerminalStore";

const GREEN = "#00c853";
const BROWN = "#8b6b3f";
const GRAY = "#7b8794";

export function StatusDot({ terminalId }: { terminalId: string }) {
  const hasDetectedActivity = useTerminalStore((state) => state.sessions[terminalId]?.hasDetectedActivity ?? false);
  const isNeedsAttention = useTerminalStore((state) => state.sessions[terminalId]?.isNeedsAttention ?? false);
  const isPossiblyDone = useTerminalStore((state) => state.sessions[terminalId]?.isPossiblyDone ?? false);
  const isLongInactive = useTerminalStore((state) => state.sessions[terminalId]?.isLongInactive ?? false);
  const backgroundColor = !hasDetectedActivity
      ? GRAY
      : isNeedsAttention
        ? GREEN
      : isLongInactive
        ? GRAY
      : isPossiblyDone
        ? BROWN
        : GREEN;
  const className = isNeedsAttention ? "status-dot status-dot-pulsing" : "status-dot";

  return (
    <span
      className={className}
      style={{ backgroundColor }}
    />
  );
}
