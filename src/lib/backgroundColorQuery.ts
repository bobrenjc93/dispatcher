/**
 * Answering "what colour is your background?" without the round trip.
 *
 * A program asks with OSC 11 and waits a short moment for the reply. Letting
 * the renderer answer means the question crosses ssh to the desktop, is
 * parsed and drawn, comes back out of xterm, and returns over ssh as a tmux
 * command -- two hops and a paint, on a control stream that may already have
 * commands queued ahead of it. Codex gives up long before that on a busy
 * session, assumes a light terminal, and draws its status line in black.
 *
 * Dispatcher knows the answer without asking anybody: it chose the colour. So
 * it replies the moment it sees the question, and takes the question out of
 * the stream so the renderer does not answer it a second time.
 */

const BACKGROUND_QUERY = /\x1b\]11;\?(?:\x07|\x1b\\)/g;

/** Whether a chunk of pane output contains the question. */
export function hasBackgroundColorQuery(data: string): boolean {
  BACKGROUND_QUERY.lastIndex = 0;
  const found = BACKGROUND_QUERY.test(data);
  BACKGROUND_QUERY.lastIndex = 0;
  return found;
}

/**
 * The same chunk with the question removed.
 *
 * Left in, the renderer would answer it too, and the program would read the
 * second reply as keystrokes.
 */
export function stripBackgroundColorQuery(data: string): string {
  BACKGROUND_QUERY.lastIndex = 0;
  const stripped = data.replace(BACKGROUND_QUERY, "");
  BACKGROUND_QUERY.lastIndex = 0;
  return stripped;
}

/**
 * The reply, in the form xterm uses.
 *
 * Channels are doubled to sixteen bits -- `0a` becomes `0a0a` -- because that
 * is what every terminal sends and what every client is written to parse.
 */
export function buildBackgroundColorReply(background: string): string | null {
  const hex = background.trim().replace(/^#/, "");
  const full = hex.length === 3
    ? hex.split("").map((ch) => ch + ch).join("")
    : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) {
    return null;
  }
  const channel = (at: number) => {
    const pair = full.slice(at, at + 2).toLowerCase();
    return `${pair}${pair}`;
  };
  return `\u001b]11;rgb:${channel(0)}/${channel(2)}/${channel(4)}\u001b\\`;
}
