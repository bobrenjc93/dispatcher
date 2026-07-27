import { useTerminalStore } from "../../stores/useTerminalStore";

const GREEN = "#00c853";
const BROWN = "#8b6b3f";
const GRAY = "#7b8794";

export function resolveStatusDotColor(status: {
  hasDetectedActivity: boolean;
  isNeedsAttention: boolean;
  isPossiblyDone: boolean;
  isLongInactive: boolean;
  isPinnedGreen: boolean;
}): string {
  if (status.isPinnedGreen) {
    return GREEN;
  }
  if (!status.hasDetectedActivity) {
    return GRAY;
  }
  if (status.isNeedsAttention) {
    return GREEN;
  }
  if (status.isLongInactive) {
    return GRAY;
  }
  return status.isPossiblyDone ? BROWN : GREEN;
}

export function StatusDot({ terminalId }: { terminalId: string }) {
  const hasDetectedActivity = useTerminalStore((state) => state.sessions[terminalId]?.hasDetectedActivity ?? false);
  const isNeedsAttention = useTerminalStore((state) => state.sessions[terminalId]?.isNeedsAttention ?? false);
  const isPossiblyDone = useTerminalStore((state) => state.sessions[terminalId]?.isPossiblyDone ?? false);
  const isLongInactive = useTerminalStore((state) => state.sessions[terminalId]?.isLongInactive ?? false);
  const isPinnedGreen = useTerminalStore((state) => state.sessions[terminalId]?.isPinnedGreen ?? false);
  // Color meaning is owned by terminalScreenshotStatus.ts. Keep this component
  // as a dumb renderer so future changes do not split the state machine across
  // UI and monitor code.
  const backgroundColor = resolveStatusDotColor({
    hasDetectedActivity,
    isNeedsAttention,
    isPossiblyDone,
    isLongInactive,
    isPinnedGreen,
  });
  return (
    <span
      className="status-dot"
      style={{ backgroundColor, color: backgroundColor }}
    />
  );
}
