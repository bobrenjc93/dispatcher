import { invoke, Channel } from "@tauri-apps/api/core";
import { getClientId } from "./clientId";
import { getNativeStorageNamespace } from "./storageNamespace";

export interface TerminalOutputPayload {
  terminal_id: string;
  data: string;
}

export interface TerminalDebugInfo {
  terminal_id: string;
  foreground_pgid: number | null;
  foreground_command: string | null;
  vdiscard: number | null;
  vreprint: number | null;
}

export interface RendererHeartbeatDetails {
  sequence: number;
  reason: string;
  href: string | null;
  visibilityState: string | null;
  activeTerminalId: string | null;
  activeTerminalBackendKind: string | null;
  sessionCount: number;
  localCount: number;
  tmuxTransportCount: number;
  tmuxWindowCount: number;
  tmuxPaneCount: number;
  skippedHeartbeatCount: number;
}

/**
 * Starts the terminal, or — when its PTY is still running from before a reload
 * — reattaches to it and replays the output this UI missed. Reattaching is what
 * keeps an ssh connection and its tmux client alive across a reload.
 */
export async function createTerminal(
  terminalId: string,
  onOutput: Channel<TerminalOutputPayload>,
  cwd?: string,
  cols: number = 80,
  rows: number = 24
): Promise<void> {
  await invoke("create_terminal", {
    terminalId,
    cwd: cwd ?? null,
    cols,
    rows,
    onOutput,
  });
}

export async function writeTerminal(
  terminalId: string,
  data: string
): Promise<void> {
  await invoke("write_terminal", { terminalId, data });
}

export async function resizeTerminal(
  terminalId: string,
  cols: number,
  rows: number
): Promise<void> {
  await invoke("resize_terminal", { terminalId, cols, rows });
}

export async function closeTerminal(terminalId: string): Promise<void> {
  await invoke("close_terminal", { terminalId });
}

export async function warmPool(count: number = 3): Promise<void> {
  await invoke("warm_pool", { count });
}

export async function refreshPool(): Promise<void> {
  await invoke("refresh_pool");
}

/**
 * Terminals whose PTY is still running in the backend. PTYs outlive the UI, so
 * after a reload this distinguishes a session that can be reattached from one
 * that only exists in saved state.
 */
export async function listLiveTerminals(): Promise<string[]> {
  return await invoke("list_live_terminals");
}

export async function getTerminalCwd(terminalId: string): Promise<string | null> {
  return await invoke("get_terminal_cwd", { terminalId });
}

export async function getTerminalDebugInfo(terminalId: string): Promise<TerminalDebugInfo> {
  return await invoke("get_terminal_debug_info", { terminalId });
}

/**
 * Bounce the dock once more, replacing any bounce in progress.
 *
 * Not `requestUserAttention`: Tauri's cancel is a no-op, so a pending request
 * can never be retired and asking again is coalesced into nothing.
 */
export async function pulseDockAttention(): Promise<number> {
  return await invoke("pulse_dock_attention");
}

export async function cancelDockAttention(): Promise<void> {
  await invoke("cancel_dock_attention");
}

export async function showFontPanel(
  family: string,
  size: number,
  weight: string
): Promise<void> {
  await invoke("show_font_panel", { family, size, weight });
}

export async function hideFontPanel(): Promise<void> {
  await invoke("hide_font_panel");
}

export async function appendDebugLog(message: string): Promise<void> {
  await invoke("append_debug_log", { message });
}

export async function rendererHeartbeat(
  details: RendererHeartbeatDetails
): Promise<void> {
  await invoke("renderer_heartbeat", { details });
}

export async function getDebugLogPath(): Promise<string> {
  return await invoke("get_debug_log_path");
}

export async function writeDebugArtifact(
  fileName: string,
  content: string
): Promise<string> {
  return await invoke("write_debug_artifact", { fileName, content });
}

export async function readAppStateBackup(): Promise<string | null> {
  return await invoke("read_app_state_backup", {
    storageNamespace: getNativeStorageNamespace(),
  });
}

export async function writeAppStateBackup(content: string): Promise<string> {
  return await invoke("write_app_state_backup", {
    content,
    storageNamespace: getNativeStorageNamespace(),
    clientId: getClientId(),
  });
}

/**
 * The newest snapshot any client has published this run, used so a client that
 * joins late adopts what the others are already showing instead of whatever
 * its own localStorage remembers.
 */
export async function readSharedAppState(): Promise<string | null> {
  return await invoke("read_shared_app_state");
}

export interface WebServerInfo {
  enabled: boolean;
  port: number;
  urls: string[];
}

export async function getWebServerInfo(): Promise<WebServerInfo> {
  return await invoke("get_web_server_info");
}

export async function getAppStateBackupPath(): Promise<string> {
  return await invoke("get_app_state_backup_path", {
    storageNamespace: getNativeStorageNamespace(),
  });
}
