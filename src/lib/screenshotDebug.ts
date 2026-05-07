export interface ScreenshotDebugEntry {
  id: number;
  generation: number;
  timestamp: string;
  timestampMs: number;
  terminalId: string;
  hash: string;
  previousHash: string | null;
  componentTerminalIds?: string[];
  componentHashes?: string[];
  componentImageDataUrls?: string[];
  changed: boolean;
  changedForStatus?: boolean;
  ignoreVisualChange?: boolean;
  visualChangeIgnoredReason?: string;
  exactChanged?: boolean;
  repeatingHashOscillation?: boolean;
  hasThreeSamples?: boolean;
  changedRows?: number;
  changedChars?: number;
  changedRowRatio?: number;
  changedCharRatio?: number;
  hasDetectedActivity: boolean;
  isNeedsAttention: boolean;
  isPossiblyDone: boolean;
  isLongInactive: boolean;
  imageDataUrl?: string;
}

const SCREENSHOT_DEBUG_EVENT = "dispatcher:screenshot-debug";
const MAX_SCREENSHOT_DEBUG_ENTRIES = 24;
const SCREENSHOT_DEBUG_TTL_MS = 60 * 60 * 1000;

let nextId = 1;
let generation = 1;
const entries: ScreenshotDebugEntry[] = [];

export function pushScreenshotDebug(
  entry: Omit<ScreenshotDebugEntry, "id" | "generation" | "timestamp" | "timestampMs">
): void {
  const now = new Date();
  const cutoff = now.getTime() - SCREENSHOT_DEBUG_TTL_MS;

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

  if (entries.length > MAX_SCREENSHOT_DEBUG_ENTRIES) {
    entries.shift();
  }

  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(SCREENSHOT_DEBUG_EVENT));
  }
}

export function clearScreenshotDebugEntries(): number {
  entries.length = 0;
  generation += 1;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(SCREENSHOT_DEBUG_EVENT));
  }
  return generation;
}

export function getCurrentScreenshotDebugGeneration(): number {
  return generation;
}

export function getScreenshotDebugEntries(): ScreenshotDebugEntry[] {
  return [...entries];
}

export function subscribeScreenshotDebug(listener: (next: ScreenshotDebugEntry[]) => void): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }

  const onEvent = () => listener(getScreenshotDebugEntries());
  window.addEventListener(SCREENSHOT_DEBUG_EVENT, onEvent as EventListener);
  return () => window.removeEventListener(SCREENSHOT_DEBUG_EVENT, onEvent as EventListener);
}
