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
import { isWebClient } from "./webBridge";

const MIRROR_EVENT = "dispatcher-mirror";
const ACTION_EVENT = "dispatcher-action";

/**
 * How much of each terminal the master remembers for replicas that join late.
 *
 * This is the only history a replica can ever have: the desktop keeps 50k lines
 * of xterm scrollback, but a replica starts empty and sees exactly what was
 * mirrored to it.
 *
 * The number has to clear one full-history replay in a single piece. Restoring
 * a tmux pane's scrollback arrives here as one write, and those run to 722KB on
 * a real agent pane — so the old 256KB budget cut a replay down to its last
 * third and the replica's history began partway through a frame. Sized well
 * clear of that, because a pane that has been running longer produces a larger
 * one, and the cost of being short is losing history rather than wasting bytes.
 *
 * Snapshots are sent per terminal, so this bounds one message rather than being
 * multiplied by the number of terminals in the workspace.
 */
const SNAPSHOT_LIMIT_BYTES = 4 * 1024 * 1024;
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

export type MirrorFrame =
  | { kind: "output"; terminalId: string; data: string }
  | { kind: "size"; terminalId: string; cols: number; rows: number }
  | { kind: "reset"; terminalId: string };

interface MirrorPayload {
  frames: MirrorFrame[];
  /** Set when replaying a snapshot to one replica; others ignore it. */
  targetClientId?: string;
}

/** Recent output per terminal, replayed to replicas that connect later. */
const snapshotBuffers = new Map<string, string>();
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
export function trimSnapshotBuffer(buffer: string, limit = SNAPSHOT_LIMIT_BYTES): string {
  if (buffer.length <= limit) {
    return buffer;
  }

  const overflow = buffer.length - limit;
  const newline = buffer.indexOf("\n", overflow);
  return newline === -1 ? buffer.slice(overflow) : buffer.slice(newline + 1);
}

function appendSnapshot(terminalId: string, data: string) {
  snapshotBuffers.set(
    terminalId,
    trimSnapshotBuffer((snapshotBuffers.get(terminalId) ?? "") + data)
  );
}

function queueFrame(frame: MirrorFrame) {
  pendingFrames.push(frame);
  if (flushTimer !== null) {
    return;
  }
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const frames = pendingFrames;
    pendingFrames = [];
    if (frames.length > 0) {
      void publishMirror({ frames });
    }
  }, MIRROR_FLUSH_MS);
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
 * Record output the master just wrote into a terminal. Called for every
 * terminal regardless of backend, so tmux panes mirror exactly like local
 * shells — by the time output reaches here the control protocol has already
 * been decoded into plain pane data.
 */
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

export function mirrorTerminalOutput(terminalId: string, data: string) {
  if (!isPrimaryClient() || !data) {
    return;
  }

  // Keep the snapshot current even with no replicas attached, so one that
  // connects a moment from now still sees the screen it missed.
  appendSnapshot(terminalId, data);

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

export function forgetMirroredTerminal(terminalId: string) {
  snapshotBuffers.delete(terminalId);
  lastPublishedSize.delete(terminalId);
}

/**
 * Replay one terminal's current screen to a replica that asked for it.
 *
 * Deliberately one terminal at a time rather than the whole workspace. Every
 * snapshot a replica receives gets an xterm instance built for it and the whole
 * buffer parsed into it, mounted or not — so replaying twenty terminals at once
 * meant tens of megabytes over the wire and twenty parsers running flat out on
 * the phone's main thread, which is why a freshly loaded page painted and then
 * ignored typing for another ten seconds. Replicas ask per terminal as each one
 * comes on screen, so the cost tracks what is actually being looked at.
 */
function sendSnapshotTo(targetClientId: string, terminalId: string) {
  const data = snapshotBuffers.get(terminalId) ?? "";
  const frames: MirrorFrame[] = [{ kind: "reset", terminalId }];
  const size = resolveGrid(terminalId);
  if (size) {
    frames.push({ kind: "size", terminalId, cols: size.cols, rows: size.rows });
  }
  if (data) {
    frames.push({ kind: "output", terminalId, data });
  }
  void publishMirror({ frames, targetClientId });

  debugLog("replication", "sending snapshot to replica", {
    targetClientId,
    terminalId,
    bytes: data.length,
  });
}

type MirrorFrameHandler = (frame: MirrorFrame) => void;

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

/** Replica side: apply frames the master sends. */
export async function startMirrorConsumer(
  onFrame: MirrorFrameHandler
): Promise<UnlistenFn> {
  const clientId = getClientId();
  let receivedFrames = 0;
  let appliedFrames = 0;
  let lastLoggedAt = 0;

  return listen<MirrorPayload>(MIRROR_EVENT, (event) => {
    const payload = event.payload;
    const frames = payload.frames ?? [];
    receivedFrames += frames.length;

    const forOtherReplica = Boolean(payload.targetClientId) && payload.targetClientId !== clientId;
    if (!forOtherReplica) {
      const applyStartedAt = performance.now();
      // Only a snapshot reply resets, so a reset marks this batch as one and
      // names the terminal it answers for.
      let snapshotTerminalId: string | null = null;
      let snapshotBytes = 0;

      for (const frame of frames) {
        appliedFrames += 1;
        if (frame.kind === "reset") {
          snapshotTerminalId = frame.terminalId;
        } else if (frame.kind === "output") {
          snapshotBytes += frame.data.length;
        }
        onFrame(frame);
      }

      if (snapshotTerminalId) {
        const requestedAt = snapshotRequestedAt.get(snapshotTerminalId);
        snapshotRequestedAt.delete(snapshotTerminalId);
        debugLog("replication", "replica snapshot applied", {
          terminalId: snapshotTerminalId,
          bytes: snapshotBytes,
          // Request to arrival: the desktop's own work plus the wire.
          waitMs: requestedAt === undefined ? null : Math.round(performance.now() - requestedAt),
          // Time inside xterm's parser, which is what freezes the phone.
          applyMs: Math.round(performance.now() - applyStartedAt),
          atMs: sincePageLoadMs(),
        });

        if (!hasLoggedFirstTerminalReady) {
          hasLoggedFirstTerminalReady = true;
          debugLog("replication", "replica first terminal ready", {
            terminalId: snapshotTerminalId,
            bytes: snapshotBytes,
            atMs: sincePageLoadMs(),
          });
        }
      }
    }

    const now = Date.now();
    if (now - lastLoggedAt >= 5_000) {
      lastLoggedAt = now;
      debugLog("replication", "replica mirror stream", {
        receivedFrames,
        appliedFrames,
        batch: frames.length,
        targeted: payload.targetClientId ?? null,
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
  deleteProject: (projectId: string) => void;
  renameTerminal: (terminalId: string, name: string) => void;
  focusTerminal: (terminalId: string) => void;
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
        sendSnapshotTo(targetClientId, terminalId);
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
