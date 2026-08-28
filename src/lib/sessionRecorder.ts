/**
 * Frontend half of session recording.
 *
 * The backend already captures both directions of every PTY, which for an
 * ssh + tmux tab is the whole control-mode conversation. What it cannot see is
 * how that one multiplexed stream was split back into panes — and that split is
 * what a pane's terminal actually renders. So tmux-backed panes also record
 * their decoded stream here, and the geometry decisions taken along the way go
 * into the event log next to it.
 *
 * Local shells are skipped: their pane stream is byte-for-byte the transport
 * stream the backend already has.
 */

import { invoke } from "@tauri-apps/api/core";
import { isPrimaryClient } from "./replication";
import { useProjectStore } from "../stores/useProjectStore";
import { useTerminalStore } from "../stores/useTerminalStore";

/** Chunks are batched so a noisy pane costs one IPC call per tick, not per write. */
const FLUSH_INTERVAL_MS = 250;

interface PaneChunk {
  terminalId: string;
  at: number;
  data: string;
}

let pending: PaneChunk[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let recordingEnabled = true;

function scheduleFlush() {
  if (flushTimer !== null) {
    return;
  }
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const chunks = pending;
    pending = [];
    if (chunks.length === 0) {
      return;
    }
    void invoke("record_pane_output", { chunks }).catch(() => {
      // Recording is diagnostics; never let it interfere with the terminal.
      recordingEnabled = false;
    });
  }, FLUSH_INTERVAL_MS);
}

/**
 * Record bytes written into a pane's terminal. Only meaningful for tmux-backed
 * panes; the caller decides, since it already knows the backend kind.
 */
export function recordPaneOutput(terminalId: string, data: string) {
  if (!recordingEnabled || !isPrimaryClient() || !data) {
    return;
  }
  pending.push({ terminalId, at: Date.now(), data });
  scheduleFlush();
}

export function recordSessionEvent(kind: string, detail: Record<string, unknown>) {
  if (!recordingEnabled || !isPrimaryClient()) {
    return;
  }
  void invoke("record_session_event", { kind, detail }).catch(() => {});
}

export interface RecordingInfo {
  enabled: boolean;
  directory: string;
  recordings: number;
}

export async function getRecordingInfo(): Promise<RecordingInfo> {
  return await invoke("get_recording_info");
}

export async function setRecordingEnabled(enabled: boolean): Promise<void> {
  recordingEnabled = enabled;
  await invoke("set_recording_enabled", { enabled });
}

// ---------------------------------------------------------------------------
// Terminal descriptions
// ---------------------------------------------------------------------------

const describedTerminals = new Map<string, string>();

function describeTerminal(terminalId: string): Record<string, unknown> | null {
  const session = useTerminalStore.getState().sessions[terminalId];
  if (!session) {
    return null;
  }

  const projectState = useProjectStore.getState();
  const project = Object.values(projectState.projects).find((candidate) => {
    const root = projectState.nodes[candidate.rootGroupId];
    return root?.children?.some(
      (childId) => projectState.nodes[childId]?.terminalId === terminalId
    );
  });

  return {
    title: session.title,
    project: project?.name ?? null,
    backendKind: session.backendKind,
    tmuxWindowId: session.tmuxWindowId ?? null,
    tmuxPaneId: session.tmuxPaneId ?? null,
    tmuxConnectionKey: session.tmuxConnectionKey ?? null,
    cwd: session.cwd ?? null,
  };
}

/**
 * Publishes what each terminal is, so a recording can be matched to the tab a
 * bug report names. Without this the files are just opaque ids.
 */
function syncTerminalDescriptions() {
  if (!recordingEnabled || !isPrimaryClient()) {
    return;
  }

  for (const terminalId of Object.keys(useTerminalStore.getState().sessions)) {
    const description = describeTerminal(terminalId);
    if (!description) {
      continue;
    }
    const signature = JSON.stringify(description);
    if (describedTerminals.get(terminalId) === signature) {
      continue;
    }
    describedTerminals.set(terminalId, signature);
    void invoke("describe_recorded_terminal", { terminalId, description }).catch(() => {});
  }
}

let descriptionTimer: ReturnType<typeof setTimeout> | null = null;

export function startSessionRecording() {
  if (!isPrimaryClient()) {
    return () => {};
  }

  const scheduleDescriptions = () => {
    if (descriptionTimer !== null) {
      return;
    }
    descriptionTimer = setTimeout(() => {
      descriptionTimer = null;
      syncTerminalDescriptions();
    }, 1_000);
  };

  scheduleDescriptions();
  const unsubscribeTerminals = useTerminalStore.subscribe(scheduleDescriptions);
  const unsubscribeProjects = useProjectStore.subscribe(scheduleDescriptions);

  return () => {
    unsubscribeTerminals();
    unsubscribeProjects();
    if (descriptionTimer !== null) {
      clearTimeout(descriptionTimer);
      descriptionTimer = null;
    }
  };
}
