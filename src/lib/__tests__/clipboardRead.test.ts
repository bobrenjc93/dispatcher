import { describe, expect, it } from "vitest";
import { readClipboardText } from "../clipboardRead";

describe("readClipboardText", () => {
  it("returns null when the clipboard API is absent", async () => {
    // What a phone sees on http://<lan-ip>:3003 — not a secure context, so
    // `navigator.clipboard` is undefined rather than merely unwilling.
    await expect(readClipboardText(undefined)).resolves.toBeNull();
  });

  it("returns null when the object exists but cannot read", async () => {
    await expect(
      readClipboardText({} as unknown as Pick<Clipboard, "readText">),
    ).resolves.toBeNull();
  });

  it("returns null when the read is refused", async () => {
    const clipboard = {
      readText: () => Promise.reject(new Error("NotAllowedError")),
    };
    await expect(readClipboardText(clipboard)).resolves.toBeNull();
  });

  it("returns null for an empty clipboard so callers take the fallback", async () => {
    const clipboard = { readText: () => Promise.resolve("") };
    await expect(readClipboardText(clipboard)).resolves.toBeNull();
  });

  it("returns the text when the read succeeds", async () => {
    const clipboard = { readText: () => Promise.resolve("ls -la\n") };
    await expect(readClipboardText(clipboard)).resolves.toBe("ls -la\n");
  });
});
