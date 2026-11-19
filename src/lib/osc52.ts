/**
 * OSC 52: a program asking the terminal to put text on the clipboard.
 *
 * It is how a program copies when it has no clipboard of its own to reach --
 * anything over ssh, and Claude Code's full-screen renderer, which draws and
 * copies its own selection. tmux hands the sequence through in the pane's
 * output untouched, and xterm.js does nothing with it unless told to, so a
 * selection made there said "copied" and the clipboard never changed.
 */

/** Generous for anything selected by hand; refuses a program flooding it. */
const MAX_OSC52_BASE64_LENGTH = 4 * 1024 * 1024;

/**
 * The text an OSC 52 payload (`Pc;Pd`) asks to be copied, or null when it is
 * not a copy.
 *
 * A `?` asks for the clipboard back. That is never answered: anything running
 * in the terminal, on any host it is ssh'd into, could read whatever was last
 * copied on this machine.
 */
export function parseOsc52Copy(data: string): string | null {
  const separator = data.indexOf(";");
  if (separator === -1) {
    return null;
  }
  const payload = data.slice(separator + 1);
  if (!payload || payload === "?" || payload.length > MAX_OSC52_BASE64_LENGTH) {
    return null;
  }

  try {
    const binary = atob(payload);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * How recently someone has to have used a terminal for its copy to count.
 *
 * The same output reaches every window showing the terminal and is replayed
 * when one reconnects, so without this a phone opening the app would copy
 * whatever was last selected on the desktop, and a selection made on the phone
 * would overwrite the desktop's clipboard. Only the screen the selection was
 * actually made on takes it.
 */
export const OSC52_INTERACTION_WINDOW_MS = 15_000;
