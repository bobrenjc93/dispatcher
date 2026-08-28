import { listen, UnlistenFn } from "@tauri-apps/api/event";

export interface TerminalExitPayload {
  terminal_id: string;
  exit_code: number | null;
}

/**
 * The grid size a terminal settled on after the backend arbitrated between all
 * attached clients. Every client renders at this size so the native window and
 * the browser show the same wrapping.
 */
export interface TerminalResizedPayload {
  terminal_id: string;
  cols: number;
  rows: number;
}

export interface AppStateChangedPayload {
  content: string;
  originClientId: string | null;
}

export function onTerminalExit(
  callback: (payload: TerminalExitPayload) => void
): Promise<UnlistenFn> {
  return listen<TerminalExitPayload>("terminal-exit", (event) => {
    callback(event.payload);
  });
}

export function onTerminalResized(
  callback: (payload: TerminalResizedPayload) => void
): Promise<UnlistenFn> {
  return listen<TerminalResizedPayload>("terminal-resized", (event) => {
    callback(event.payload);
  });
}

export function onAppStateChanged(
  callback: (payload: AppStateChangedPayload) => void
): Promise<UnlistenFn> {
  return listen<AppStateChangedPayload>("app-state-changed", (event) => {
    callback(event.payload);
  });
}
