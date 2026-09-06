import { useTerminalStore } from "../../stores/useTerminalStore";
import { isSnoozeActive } from "../../lib/snooze";

const GREEN = "#00c853";
const BROWN = "#8b6b3f";
const GRAY = "#7b8794";

export function resolveStatusDotColor(status: {
  hasDetectedActivity: boolean;
  isNeedsAttention: boolean;
  isPossiblyDone: boolean;
  isLongInactive: boolean;
  isPinnedGreen: boolean;
  isPinnedGray: boolean;
  isSnoozed: boolean;
}): string {
  if (status.isPinnedGray) {
    return GRAY;
  }
  // A snooze outranks everything the monitor derived: the whole point is that
  // the user has already decided this tab is fine for now.
  if (status.isPinnedGreen || status.isSnoozed) {
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
  const isPinnedGray = useTerminalStore((state) => state.sessions[terminalId]?.isPinnedGray ?? false);
  // The monitor clears `snoozedUntil` when it lapses, and that patch is what
  // re-renders this — so there is no clock here.
  const snoozedUntil = useTerminalStore((state) => state.sessions[terminalId]?.snoozedUntil);
  // Color meaning is owned by terminalScreenshotStatus.ts. Keep this component
  // as a dumb renderer so future changes do not split the state machine across
  // UI and monitor code.
  const backgroundColor = resolveStatusDotColor({
    hasDetectedActivity,
    isNeedsAttention,
    isPossiblyDone,
    isLongInactive,
    isPinnedGreen,
    isPinnedGray,
    isSnoozed: isSnoozeActive(snoozedUntil, Date.now()),
  });
  return (
    <span
      className="status-dot"
      style={{ backgroundColor, color: backgroundColor }}
    />
  );
}
