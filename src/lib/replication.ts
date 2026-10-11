/**
 * Desktop-as-master replication.
 *
 * The desktop window is the only Dispatcher client that owns PTYs and drives
 * tmux. A browser is a *replica*: it renders what the desktop mirrors to it,
 * and anything the user does there is relayed to the desktop to perform. That
 * asymmetry is what keeps a single writer on every PTY and, crucially, a single
 * driver on the tmux control stream — which multiplexes commands and replies
 * over one connection and cannot tolerate two clients at once.
 *
 * Two channels, opposite directions:
 *
 * - **mirror** (master → replicas) terminal output and grid sizes
 * - **action** (replica → master) user intent, performed on the master
 *
 * The workspace document (projects, tabs, splits, notes) rides the same
 * asymmetry: the desktop publishes it as a snapshot, and a replica sends back
 * only the fields it edited, as a `documentPatch` action. See
 * `documentPatch.ts` for why a replica must not republish the whole thing.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getClientId } from "./clientId";
import { debugLog } from "./debugLog";
import type { PushRegistration } from "./webPushSubscribe";
import type { DocumentPatch } from "./documentPatch";
import type { TerminalSettingsPatch } from "./terminalSettings";
import { isWebClient } from "./webBridge";

const MIRROR_EVENT = "dispatcher-mirror";
const ACTION_EVENT = "dispatcher-action";

/**
 * How much of a terminal a joining replica is sent.
 *
 * Sized for the phone rather than the desktop: a pane at 4MB took 21 seconds
 * to arrive on a phone, against 27ms to parse once it did. Pure transfer, and
 * the whole app waits on it — snapshots for other terminals queue behind it on
 * the same socket, so a tab with no output at all was also 21 seconds late.
 *
 * Sized from that measurement rather than picked: the link ran at roughly
 * 200KB/s, so this is a few seconds. It is still thousands of lines of
 * scrollback, which is what the number is really trading against.
 */
export const REPLICA_SNAPSHOT_LIMIT_BYTES = 512 * 1024;
/**
 * How far past its budget a retained buffer may grow before it is cut back.
 *
 * Cutting on every chunk copied the whole buffer every time a busy terminal
 * printed anything. Letting it run over and cutting in one go keeps the cost
 * proportional to the output instead.
 */
const RETAINED_OUTPUT_SLACK_BYTES = 128 * 1024;
/** Mirror frames are coalesced over this window to keep the IPC chatter down. */
const MIRROR_FLUSH_MS = 16;

export function isReplicaClient(): boolean {
  return isWebClient();
}

export function isPrimaryClient(): boolean {
  return !isWebClient();
}

// ---------------------------------------------------------------------------
// Mirror channel: master → replicas
// ---------------------------------------------------------------------------

export type MirrorFrame = (
  | { kind: "output"; terminalId: string; data: string }
  | { kind: "size"; terminalId: string; cols: number; rows: number }
  /** Starts a snapshot: everything this replica had for the terminal is replaced. */
  | { kind: "reset"; terminalId: string }
  /**
   * The desktop rebuilt this terminal from its backend, so a replica's copy
   * may no longer match. Cheaper than sending the rebuild itself, which for a
   * tmux pane is its entire history — a replica that cares asks for a
   * snapshot sized for it instead.
   */
  | { kind: "invalidate"; terminalId: string }
) & {
  /** Set on a snapshot reply; every other replica ignores the frame. */
  targetClientId?: string;
};

interface MirrorPayload {
  /**
   * In the order the master produced them. Snapshot replies travel in the
   * same stream as live output rather than beside it, because their meaning
   * depends on where they fall: output queued before a snapshot is already in
   * it, and output queued after is not.
   */
  frames: MirrorFrame[];
}

/**
 * Recent output for terminals whose backend cannot be asked for it again.
 *
 * A local shell's history exists nowhere but in the stream, so this is all a
 * late replica can be given. A tmux pane is not kept here: tmux holds its
 * history, and a snapshot asks tmux for it directly.
 */
interface RetainedOutput {
  chunks: string[];
  length: number;
}
const retainedOutput = new Map<string, RetainedOutput>();
const lastPublishedSize = new Map<string, { cols: number; rows: number }>();

type TerminalGrid = { cols: number; rows: number };
let terminalGridProvider: ((terminalId: string) => TerminalGrid | null) | null = null;

/**
 * Lets the master look up a terminal's grid on demand. Sizes are otherwise only
 * published when a pane is mounted, so a tab sitting in the background would
 * reach replicas with no size at all and render at xterm's 24-row default.
 */
export function setTerminalGridProvider(
  provider: ((terminalId: string) => TerminalGrid | null) | null
) {
  terminalGridProvider = provider;
}

function resolveGrid(terminalId: string): TerminalGrid | null {
  return lastPublishedSize.get(terminalId) ?? terminalGridProvider?.(terminalId) ?? null;
}

let pendingFrames: MirrorFrame[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let publishInFlight = false;
let replicaCount = 0;
let sawReplicaEvent = false;

/** Mirroring costs an IPC round trip per frame, so only do it when watched. */
function shouldMirror(): boolean {
  return isPrimaryClient() && replicaCount > 0;
}

/**
 * Seed the count at startup. Ignored once a live event has arrived: the initial
 * query is async, so a replica that connects while it is in flight would
 * otherwise be erased when the stale zero came back — leaving the master
 * convinced nobody is watching and silently not mirroring.
 */
export function initReplicaCount(count: number) {
  if (sawReplicaEvent) {
    return;
  }
  setReplicaCount(count);
}

export function setReplicaCount(count: number) {
  const had = replicaCount > 0;
  replicaCount = count;
  if (!had && count > 0) {
    debugLog("replication", "replica attached", { replicaCount: count });
  } else if (had && count === 0) {
    debugLog("replication", "no replicas attached", {});
    pendingFrames = [];
  }
}

/** Marks that the count is now being driven by live events. */
export function markReplicaEventSeen() {
  sawReplicaEvent = true;
}

/**
 * A replica just handshook, so one is definitely watching. Presence events can
 * be missed — the master's listener is registered asynchronously at startup, so
 * a replica connecting in that window is invisible to it — and without this the
 * master would happily never mirror anything.
 */
function noteReplicaPresent() {
  sawReplicaEvent = true;
  if (replicaCount < 1) {
    setReplicaCount(1);
  }
}

/**
 * Drop the oldest output once a snapshot outgrows its budget, cutting at a line
 * boundary. Slicing at an arbitrary byte can land inside an escape sequence,
 * and the replica then renders the tail of it as literal text at the very top
 * of its scrollback. Escape sequences never span a newline, so a newline is
 * always a safe place to start.
 */
export function trimSnapshotBuffer(
  buffer: string,
  limit = REPLICA_SNAPSHOT_LIMIT_BYTES
): string {
  if (buffer.length <= limit) {
    return buffer;
  }

  const overflow = buffer.length - limit;
  const newline = buffer.indexOf("\n", overflow);
  return newline === -1 ? buffer.slice(overflow) : buffer.slice(newline + 1);
}

function retainOutput(terminalId: string, data: string) {
  let retained = retainedOutput.get(terminalId);
  if (!retained) {
    retained = { chunks: [], length: 0 };
    retainedOutput.set(terminalId, retained);
  }
  retained.chunks.push(data);
  retained.length += data.length;
  if (retained.length > REPLICA_SNAPSHOT_LIMIT_BYTES + RETAINED_OUTPUT_SLACK_BYTES) {
    readRetainedOutput(terminalId);
  }
}

function readRetainedOutput(terminalId: string): string {
  const retained = retainedOutput.get(terminalId);
  if (!retained) {
    return "";
  }
  const data = trimSnapshotBuffer(retained.chunks.join(""));
  retained.chunks = data ? [data] : [];
  retained.length = data.length;
  return data;
}

function queueFrame(frame: MirrorFrame) {
  pendingFrames.push(frame);
  scheduleFlush();
}

function scheduleFlush() {
  if (flushTimer !== null || publishInFlight) {
    return;
  }
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushFrames();
  }, MIRROR_FLUSH_MS);
}

/**
 * One publish at a time. Two invokes in flight are not guaranteed to arrive in
 * the order they were made, and a snapshot overtaking the output before it
 * would replay that output on top of a screen that already contains it.
 */
async function flushFrames() {
  if (pendingFrames.length === 0) {
    return;
  }
  const frames = pendingFrames;
  pendingFrames = [];
  publishInFlight = true;
  try {
    await publishMirror({ frames });
  } finally {
    publishInFlight = false;
    if (pendingFrames.length > 0) {
      scheduleFlush();
    }
  }
}

async function publishMirror(payload: MirrorPayload) {
  try {
    await invoke("publish_mirror", { payload });
  } catch (error) {
    debugLog("replication", "failed to publish mirror frames", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Master-side mirroring counters.
 *
 * The replica can only report what reached it. When it reports nothing, that is
 * equally consistent with the desktop never sending, the desktop deciding
 * nobody was listening, or the bytes being dropped before they ever got here —
 * and those have nothing in common as bugs. Counting sent against suppressed,
 * with the replica count that decided it, tells them apart.
 */
const mirroredBytesByTerminal = new Map<string, number>();
let publishedMirrorBytes = 0;
let suppressedMirrorBytes = 0;
let lastMirrorSummaryAt = 0;

function noteMirrorActivity(terminalId: string, bytes: number, published: boolean) {
  if (published) {
    publishedMirrorBytes += bytes;
    mirroredBytesByTerminal.set(
      terminalId,
      (mirroredBytesByTerminal.get(terminalId) ?? 0) + bytes
    );
  } else {
    suppressedMirrorBytes += bytes;
  }

  const now = Date.now();
  if (now - lastMirrorSummaryAt < 5_000) {
    return;
  }
  lastMirrorSummaryAt = now;
  debugLog("replication", "master mirror summary", {
    replicaCount,
    publishedBytes: publishedMirrorBytes,
    // Anything here means the master believed no replica was watching.
    suppressedBytes: suppressedMirrorBytes,
    terminals: Array.from(mirroredBytesByTerminal, ([id, sent]) => `${id.slice(0, 8)}:${sent}`),
  });
  mirroredBytesByTerminal.clear();
  publishedMirrorBytes = 0;
  suppressedMirrorBytes = 0;
}

/**
 * Record output for a terminal. Called for every terminal regardless of
 * backend, so tmux panes mirror exactly like local shells — by the time output
 * reaches here the control protocol has already been decoded into plain pane
 * data.
 *
 * `retain` is for output nothing else can reproduce. Leave it off for a
 * terminal whose backend can be asked for its history when a replica joins.
 */
export function mirrorTerminalOutput(
  terminalId: string,
  data: string,
  options?: { retain?: boolean }
) {
  if (!isPrimaryClient() || !data) {
    return;
  }

  // Kept even with no replicas attached, so one that connects a moment from
  // now still sees the screen it missed.
  if (options?.retain !== false) {
    retainOutput(terminalId, data);
  }

  // First output from a terminal nobody has mounted yet: publish its grid now,
  // or the replica would render it at the wrong size.
  if (!lastPublishedSize.has(terminalId)) {
    const grid = terminalGridProvider?.(terminalId);
    if (grid) {
      mirrorTerminalSize(terminalId, grid.cols, grid.rows);
    }
  }

  const published = shouldMirror();
  if (published) {
    queueFrame({ kind: "output", terminalId, data });
  }
  noteMirrorActivity(terminalId, data.length, published);
}

export function mirrorTerminalSize(terminalId: string, cols: number, rows: number) {
  if (!isPrimaryClient() || cols <= 0 || rows <= 0) {
    return;
  }

  const last = lastPublishedSize.get(terminalId);
  if (last && last.cols === cols && last.rows === rows) {
    return;
  }
  lastPublishedSize.set(terminalId, { cols, rows });

  if (shouldMirror()) {
    queueFrame({ kind: "size", terminalId, cols, rows });
  }
}

/**
 * Tell replicas their copy of a terminal may be out of date.
 *
 * For when the desktop rebuilds a terminal from its backend — a tmux pane
 * reattached after the control stream dropped — and whatever happened in the
 * gap never passed through here.
 */
export function invalidateMirroredTerminal(terminalId: string) {
  if (!shouldMirror()) {
    return;
  }
  queueFrame({ kind: "invalidate", terminalId });
}

export function forgetMirroredTerminal(terminalId: string) {
  retainedOutput.delete(terminalId);
  lastPublishedSize.delete(terminalId);
}

/**
 * Captures a terminal's history from its backend for a replica.
 *
 * Returns false when it does not own the terminal. Otherwise `deliver` is
 * called exactly once, with a replay that draws the terminal from blank — or
 * null if the capture failed — and it has to be called at the point in the
 * output stream the capture describes, before any output after it is
 * mirrored. That ordering is what lets the replica apply live output on top
 * without gaps or repeats.
 */
export type TerminalSnapshotSource = (
  terminalId: string,
  maxBytes: number,
  deliver: (replay: string | null) => void
) => boolean;

let terminalSnapshotSource: TerminalSnapshotSource | null = null;

export function setTerminalSnapshotSource(source: TerminalSnapshotSource | null) {
  terminalSnapshotSource = source;
}

/**
 * Replay one terminal's screen and history to a replica that asked for it.
 *
 * Deliberately one terminal at a time rather than the whole workspace. Every
 * snapshot a replica receives gets an xterm instance built for it and the whole
 * buffer parsed into it — so replaying twenty terminals at once meant tens of
 * megabytes over the wire and twenty parsers running flat out on the phone's
 * main thread. Replicas ask per terminal as each one comes on screen, so the
 * cost tracks what is actually being looked at.
 */
function answerSnapshotRequest(targetClientId: string, terminalId: string) {
  const requestedAt = performance.now();
  const captured = terminalSnapshotSource?.(
    terminalId,
    REPLICA_SNAPSHOT_LIMIT_BYTES,
    (replay) => {
      sendSnapshotTo(targetClientId, terminalId, replay ?? "", {
        source: replay === null ? "capture-failed" : "capture",
        captureMs: Math.round(performance.now() - requestedAt),
      });
    }
  );
  if (!captured) {
    sendSnapshotTo(targetClientId, terminalId, readRetainedOutput(terminalId), {
      source: "retained",
    });
  }
}

function sendSnapshotTo(
  targetClientId: string,
  terminalId: string,
  data: string,
  details: { source: "capture" | "capture-failed" | "retained"; captureMs?: number }
) {
  queueFrame({ kind: "reset", terminalId, targetClientId });
  const size = resolveGrid(terminalId);
  if (size) {
    queueFrame({ kind: "size", terminalId, cols: size.cols, rows: size.rows, targetClientId });
  }
  if (data) {
    queueFrame({ kind: "output", terminalId, data, targetClientId });
  }

  debugLog("replication", "sending snapshot to replica", {
    targetClientId,
    terminalId,
    bytes: data.length,
    ...details,
  });
}

/** What a replica's UI applies; invalidation is handled here, by asking again. */
export type AppliedMirrorFrame = Exclude<MirrorFrame, { kind: "invalidate" }>;
type MirrorFrameHandler = (frame: AppliedMirrorFrame) => void;

/**
 * Replica load timing.
 *
 * The desktop's log says what it sent and when, which is not enough to explain
 * a slow phone: it cannot see how long the page took to get far enough to ask,
 * how long the bytes spent on the wire, or how much of the rest went into
 * parsing them into xterm. Those three have completely different fixes, so they
 * are measured separately rather than inferred from one end-to-end number.
 *
 * Milliseconds are relative to this document's navigation start, so they read
 * directly as "how far into the page load did this happen".
 */
const snapshotRequestedAt = new Map<string, number>();
let hasLoggedFirstTerminalReady = false;

function sincePageLoadMs(): number {
  return Math.round(performance.now());
}

/**
 * Whether this replica should apply a frame.
 *
 * Live output is broadcast for every terminal, but a replica only keeps a copy
 * of the ones it has asked for. Anything before the ask is covered by the
 * snapshot that answers it, so applying it would only build xterms for tabs
 * nobody on this device has opened.
 */
function isFrameForThisReplica(frame: MirrorFrame, clientId: string): boolean {
  if (frame.targetClientId) {
    return frame.targetClientId === clientId;
  }
  return requestedSnapshotTerminalIds.has(frame.terminalId);
}

function handleInvalidation(terminalId: string) {
  requestedSnapshotTerminalIds.delete(terminalId);
  debugLog("replication", "replica copy invalidated", {
    terminalId,
    shown: shownTerminalIds.has(terminalId),
  });
  // A tab off screen asks again when it next comes on screen; until then
  // there is nobody to fetch it for.
  if (shownTerminalIds.has(terminalId)) {
    requestMirrorSnapshot(terminalId);
  }
}

/** Replica side: apply frames the master sends. */
export async function startMirrorConsumer(
  onFrame: MirrorFrameHandler
): Promise<UnlistenFn> {
  const clientId = getClientId();
  let receivedFrames = 0;
  let appliedFrames = 0;
  let lastLoggedAt = 0;

  return listen<MirrorPayload>(MIRROR_EVENT, (event) => {
    const frames = event.payload.frames ?? [];
    receivedFrames += frames.length;

    const applyStartedAt = performance.now();
    // A reset starts a snapshot reply, so it names a terminal this batch
    // answers for; the targeted output after it is that snapshot's content.
    const snapshotBytes = new Map<string, number>();
    for (const frame of frames) {
      if (!isFrameForThisReplica(frame, clientId)) {
        continue;
      }
      if (frame.kind === "invalidate") {
        handleInvalidation(frame.terminalId);
        continue;
      }
      appliedFrames += 1;
      if (frame.kind === "reset") {
        snapshotBytes.set(frame.terminalId, 0);
      } else if (frame.kind === "output" && frame.targetClientId) {
        snapshotBytes.set(
          frame.terminalId,
          (snapshotBytes.get(frame.terminalId) ?? 0) + frame.data.length
        );
      }
      onFrame(frame);
    }

    for (const [terminalId, bytes] of snapshotBytes) {
      const requestedAt = snapshotRequestedAt.get(terminalId);
      snapshotRequestedAt.delete(terminalId);
      debugLog("replication", "replica snapshot applied", {
        terminalId,
        bytes,
        // Request to arrival: the desktop's own work plus the wire.
        waitMs: requestedAt === undefined ? null : Math.round(performance.now() - requestedAt),
        // Time handing it to the terminal, which is what freezes the phone.
        applyMs: Math.round(performance.now() - applyStartedAt),
        atMs: sincePageLoadMs(),
      });

      if (!hasLoggedFirstTerminalReady) {
        hasLoggedFirstTerminalReady = true;
        debugLog("replication", "replica first terminal ready", {
          terminalId,
          bytes,
          atMs: sincePageLoadMs(),
        });
      }
    }

    const now = Date.now();
    if (now - lastLoggedAt >= 5_000) {
      lastLoggedAt = now;
      debugLog("replication", "replica mirror stream", {
        receivedFrames,
        appliedFrames,
        batch: frames.length,
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Action channel: replica → master
// ---------------------------------------------------------------------------

/**
 * User actions that have effects outside the workspace document — they start,
 * stop, resize or write to something real. Only the master may perform them.
 */
export interface ReplicatedActions {
  terminalInput: (terminalId: string, data: string) => void;
  newTerminal: () => void;
  newTerminalInProject: (projectId: string) => void;
  deleteTerminal: (terminalId: string, projectId: string) => void;
  splitPane: (targetTerminalId: string, direction: "horizontal" | "vertical") => void;
  closePane: (terminalId: string) => void;
  /** ⇧⌘T: bring back the most recently closed tab. */
  reopenClosedTab: () => void;
  deleteProject: (projectId: string) => void;
  renameTerminal: (terminalId: string, name: string) => void;
  /**
   * A per-tab setting from the context menu.
   *
   * Relayed rather than written locally: a replica's edit to the workspace
   * document is overwritten by the desktop's next snapshot, so toggling Push
   * on Inactivity from a phone appeared to do nothing at all.
   */
  patchTerminalSettings: (terminalId: string, patch: TerminalSettingsPatch) => void;
  focusTerminal: (terminalId: string) => void;
  /**
   * Clear a terminal, scrollback and all.
   *
   * Relayed because the scrollback lives in tmux, not in the renderer: a
   * replica clearing its own xterm would blank the phone and leave the pane's
   * history untouched, so the next capture would put it straight back.
   */
  clearTerminal: (terminalId: string) => void;
  /** Edits a replica made to the workspace document, for the desktop to merge. */
  documentPatch: (patch: DocumentPatch) => void;
  /**
   * A device offering itself as a push target.
   *
   * Relayed like any other action so it arrives on the desktop, which is the
   * only party that can reach a push service — a replica has no way to notify
   * itself once its web app is closed, which is exactly when this matters.
   */
  registerPushSubscription: (registration: PushRegistration) => void;
}

export type ActionName = keyof ReplicatedActions;

type AnyHandler = (...args: never[]) => void;

const actionHandlers = new Map<ActionName, AnyHandler>();

/** The master registers what it can do; replicas name these over the wire. */
export function registerActionHandler<K extends ActionName>(
  name: K,
  handler: ReplicatedActions[K]
): () => void {
  actionHandlers.set(name, handler as AnyHandler);
  return () => {
    if (actionHandlers.get(name) === (handler as AnyHandler)) {
      actionHandlers.delete(name);
    }
  };
}

/**
 * Perform an action, wherever it belongs: directly on the master, or relayed
 * to the master from a replica.
 */
export function performAction<K extends ActionName>(
  name: K,
  ...args: Parameters<ReplicatedActions[K]>
): void {
  if (isPrimaryClient()) {
    runActionLocally(name, args);
    return;
  }

  void invoke("relay_action", {
    action: { name, args },
    clientId: getClientId(),
  }).catch((error) => {
    debugLog("replication", "failed to relay action", {
      name,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

function runActionLocally(name: ActionName, args: unknown[]) {
  const handler = actionHandlers.get(name);
  if (!handler) {
    debugLog("replication", "no handler for action", { name });
    return;
  }
  (handler as (...rest: unknown[]) => void)(...args);
}

interface ActionEventPayload {
  action: { name?: ActionName; args?: unknown[] } | null;
  originClientId: string | null;
}

let flushAppState: (() => void) | null = null;

/**
 * Lets a relayed action's effect reach the replicas promptly instead of waiting
 * out the app state save debounce.
 */
export function setAppStatePublishFlusher(flush: (() => void) | null) {
  flushAppState = flush;
}

/** Master side: perform actions relayed from replicas. */
export async function startActionListener(): Promise<UnlistenFn> {
  const clientId = getClientId();
  return listen<ActionEventPayload>(ACTION_EVENT, (event) => {
    const { action, originClientId } = event.payload;
    if (!action?.name || originClientId === clientId) {
      return;
    }

    if (action.name === REQUEST_SNAPSHOT) {
      noteReplicaPresent();
      const [targetClientId, terminalId] = (action.args ?? []) as [string, string];
      if (targetClientId && terminalId) {
        answerSnapshotRequest(targetClientId, terminalId);
      }
      return;
    }

    debugLog("replication", "performing relayed action", {
      name: action.name,
      originClientId,
    });
    runActionLocally(action.name, action.args ?? []);
    flushAppState?.();
  });
}

// ---------------------------------------------------------------------------
// Snapshot handshake
// ---------------------------------------------------------------------------

// Not part of ReplicatedActions: it is answered by the transport rather than by
// a UI handler, so it is kept out of the typed action surface.
const REQUEST_SNAPSHOT = "requestSnapshot" as ActionName;

/**
 * Terminals this replica has already asked to have replayed.
 *
 * The ask is made from a mount effect, which React can run more than once for
 * the same terminal — a StrictMode double-invoke, a pane moving in the tree —
 * and each duplicate would replay the entire buffer again. Keyed on terminal
 * rather than debounced because the answer never goes stale in a way a second
 * request would fix: live output keeps arriving on its own.
 */
const requestedSnapshotTerminalIds = new Set<string>();

/** The terminals this replica has on screen right now. */
const shownTerminalIds = new Set<string>();

/**
 * Forget what has been asked for, because the connection it was asked on is
 * gone.
 *
 * These records are per page, and a reconnect used to be a page load, so they
 * were never wrong. Rebuilding on a fresh socket instead means a pane can
 * mount again while this still says its snapshot was requested — so it asks
 * for nothing, the desktop replays nothing, and the tab sits showing whatever
 * it had before the phone went away. Switching to another tab and back was the
 * only way to get anything, because that tab had not been asked for yet.
 */
export function forgetRequestedSnapshots() {
  requestedSnapshotTerminalIds.clear();
  snapshotRequestedAt.clear();
}

/**
 * Replica side: these terminals are on screen now, and want content.
 *
 * Each is asked for once per connection; live output keeps it current from
 * there. One that the desktop invalidates while it is still here is asked for
 * again straight away.
 */
export function showMirroredTerminals(terminalIds: readonly string[]) {
  shownTerminalIds.clear();
  for (const terminalId of terminalIds) {
    shownTerminalIds.add(terminalId);
    requestMirrorSnapshot(terminalId);
  }
}

/** Replica side: ask the master to replay one terminal's screen and history. */
export function requestMirrorSnapshot(terminalId: string) {
  if (requestedSnapshotTerminalIds.has(terminalId)) {
    return;
  }
  requestedSnapshotTerminalIds.add(terminalId);
  snapshotRequestedAt.set(terminalId, performance.now());

  // How far into the page load the ask happens is its own measurement: it is
  // everything before the desktop is even involved — bundle, boot, workspace
  // document — and on a phone that has been the larger half.
  debugLog("replication", "replica requested snapshot", {
    terminalId,
    atMs: sincePageLoadMs(),
  });

  void invoke("relay_action", {
    action: { name: REQUEST_SNAPSHOT, args: [getClientId(), terminalId] },
    clientId: getClientId(),
  }).catch((error) => {
    // Let the next mount try again; a terminal with no snapshot shows a
    // spinner forever otherwise.
    requestedSnapshotTerminalIds.delete(terminalId);
    debugLog("replication", "failed to request snapshot", {
      terminalId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
