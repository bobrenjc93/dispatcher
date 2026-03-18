import { invoke, Channel } from "@tauri-apps/api/core";

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

export async function getTerminalCwd(terminalId: string): Promise<string | null> {
  return await invoke("get_terminal_cwd", { terminalId });
}

export async function getTerminalDebugInfo(terminalId: string): Promise<TerminalDebugInfo> {
  return await invoke("get_terminal_debug_info", { terminalId });
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
