import { useEffect } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { isWebClient } from "../lib/webBridge";
import { writeTerminal } from "../lib/tauriCommands";
import { sendInputToTmuxTerminal } from "../lib/tmuxControl";

function shellEscape(path: string): string {
  return "'" + path.replace(/'/g, "'\\''") + "'";
}

function findTerminalPane(x: number, y: number): HTMLElement | null {
  const el = document.elementFromPoint(x, y);
  return el?.closest<HTMLElement>("[data-terminal-id]") ?? null;
}

function clearHighlight() {
  document
    .querySelectorAll(".terminal-drop-target")
    .forEach((el) => el.classList.remove("terminal-drop-target"));
}

export function useFileDrop() {
  useEffect(() => {
    // Dragging files in from the OS is a native-window affair; a browser
    // replica has no webview to ask.
    if (isWebClient()) {
      return;
    }
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "enter" || event.payload.type === "over") {
        clearHighlight();
        const { x, y } = event.payload.position;
        const pane = findTerminalPane(x, y);
        if (pane) {
          pane.classList.add("terminal-drop-target");
        }
      } else if (event.payload.type === "leave") {
        clearHighlight();
      } else if (event.payload.type === "drop") {
        clearHighlight();
        const { x, y } = event.payload.position;
        const pane = findTerminalPane(x, y);
        if (pane) {
          const terminalId = pane.dataset.terminalId;
          if (terminalId && event.payload.paths.length > 0) {
            const escaped = event.payload.paths.map(shellEscape).join(" ");
            sendInputToTmuxTerminal(terminalId, escaped)
              .then((handled) => {
                if (!handled) {
                  writeTerminal(terminalId, escaped).catch(() => {});
                }
              })
              .catch(() => {});
          }
        }
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);
}
