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

/** Which colour questions the multiplexer answers for itself. */
export interface ColourQueryAnswers {
  /** OSC 10. */
  foreground: boolean;
  /** OSC 11. */
  background: boolean;
}

const SMUX_SOCKET_PATH = /\/smux-\d+\//;

/**
 * Whether the server answers OSC 10 and 11 itself, from what it says it is.
 *
 * A server that answers does it instantly, straight back into the pane, and
 * the program has its reply before the question has even reached us. Our
 * answer then arrives a network round trip later as a second one. Programs
 * stop listening once the DA1 or CPR they sent after the colour question comes
 * back -- and the server answers those too -- so the duplicate lands in the
 * program's input and is read as typing: `okc login` read its own `y` as
 * `^[]11;rgb:0a0a/0a0a/0a0a^[\y` and refused.
 *
 * tmux answers both from 3.6. 3.4 and 3.5 only answer with a colour some
 * attached client's terminal reported, and a control client reports none.
 * smux answers OSC 11 from v0.3.1 and OSC 10 from v0.3.4, the first release to
 * name itself in `#{smux_version}`; an older one is recognised by its socket,
 * since its `#{version}` is a fixed "3.2a" for iTerm2's benefit.
 */
export function multiplexerColourQueryAnswers(server: {
  version: string;
  smuxVersion: string;
  socketPath: string;
}): ColourQueryAnswers {
  if (server.smuxVersion) {
    return { foreground: true, background: true };
  }
  if (SMUX_SOCKET_PATH.test(server.socketPath)) {
    return { foreground: false, background: true };
  }
  // "3.6a", or "next-3.7" from a development build.
  const match = /(\d+)\.(\d+)/.exec(server.version);
  const answers = match !== null
    && (Number(match[1]) > 3 || (Number(match[1]) === 3 && Number(match[2]) >= 6));
  return { foreground: answers, background: answers };
}
