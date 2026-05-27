export type StatusDebugEvent = "acknowledge" | "transition" | "visual-change-ignored";

export interface StatusDebugEntry {
  id: number;
  generation: number;
  timestamp: string;
  timestampMs: number;
  terminalId: string;
  event: StatusDebugEvent;
  reason?: string;
  previousStatusSnapshot?: string | null;
  nextStatusSnapshot?: string | null;
  activeTabRootTerminalId?: string | null;
  terminalIds?: string[];
  statusTerminalIds?: string[];
  statusDotSemantic?: string;
  changed?: boolean;
  changedForStatus?: boolean;
  ignoreVisualChange?: boolean;
  visualChangeIgnoredReason?: string;
  focusVisualSuppressionUntil?: number | null;
  resizeSuppressionUntil?: number | null;
  resizeSuppressionReason?: string | null;
  resizeSuppressionTerminalId?: string | null;
  previousAcknowledgedAt?: number;
  acknowledgedTime?: number;
  hasDetectedActivity?: boolean;
  isActiveTab?: boolean;
  lastUserInputAt?: number;
  lastOutputAt?: number;
  effectiveChangedAt?: number;
  idleStartedAt?: number;
  staleStartedAt?: number;
  brownStartedAt?: number | null;
  exactChanged?: boolean;
  repeatingHashOscillation?: boolean;
  hasThreeSamples?: boolean;
  changedRows?: number;
  changedChars?: number;
  changedRowRatio?: number;
  changedCharRatio?: number;
  nextNeedsAttention?: boolean;
  nextPossiblyDone?: boolean;
  nextLongInactive?: boolean;
  shouldKeepAttentionUntilFocus?: boolean;
  shouldKeepBrownUntilInput?: boolean;
  timestampOnlyStatus?: boolean;
  backendKinds?: string[];
}

const STATUS_DEBUG_EVENT = "dispatcher:status-debug";
const MAX_STATUS_DEBUG_ENTRIES = 200;
const STATUS_DEBUG_TTL_MS = 2 * 60 * 60 * 1000;

let nextId = 1;
let generation = 1;
const entries: StatusDebugEntry[] = [];

export function pushStatusDebug(
  entry: Omit<StatusDebugEntry, "id" | "generation" | "timestamp" | "timestampMs">
): void {
  const now = new Date();
  const cutoff = now.getTime() - STATUS_DEBUG_TTL_MS;

  while (entries.length > 0 && entries[0].timestampMs < cutoff) {
    entries.shift();
  }

  entries.push({
    id: nextId++,
    generation,
    timestamp: now.toLocaleTimeString(),
    timestampMs: now.getTime(),
    ...entry,
  });

  while (entries.length > MAX_STATUS_DEBUG_ENTRIES) {
    entries.shift();
  }

  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(STATUS_DEBUG_EVENT));
  }
}

export function clearStatusDebugEntries(): number {
  entries.length = 0;
  generation += 1;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(STATUS_DEBUG_EVENT));
  }
  return generation;
}

export function getCurrentStatusDebugGeneration(): number {
  return generation;
}

export function getStatusDebugEntries(): StatusDebugEntry[] {
  return [...entries];
}

export function subscribeStatusDebug(listener: (next: StatusDebugEntry[]) => void): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }

  const onEvent = () => listener(getStatusDebugEntries());
  window.addEventListener(STATUS_DEBUG_EVENT, onEvent as EventListener);
  return () => window.removeEventListener(STATUS_DEBUG_EVENT, onEvent as EventListener);
}
