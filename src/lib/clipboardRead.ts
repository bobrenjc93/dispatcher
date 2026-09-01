/**
 * Reading the clipboard, when the browser allows it at all.
 *
 * `navigator.clipboard` only exists in a secure context, and Dispatcher's web
 * server speaks plain HTTP — so on a phone reaching it at `http://<lan-ip>:3003`
 * the whole API is simply missing. It is present at `localhost` and over HTTPS,
 * and even then a read can be refused: iOS Safari asks the user to confirm, and
 * a dismissed prompt rejects.
 *
 * All three failures mean the same thing to a caller — the clipboard is not
 * available right now, ask the user for the text another way — so they collapse
 * into a single null rather than making every caller re-derive the distinction.
 */
export async function readClipboardText(
  clipboard: Pick<Clipboard, "readText"> | undefined,
): Promise<string | null> {
  if (typeof clipboard?.readText !== "function") {
    return null;
  }
  try {
    const text = await clipboard.readText();
    return text ? text : null;
  } catch {
    return null;
  }
}
