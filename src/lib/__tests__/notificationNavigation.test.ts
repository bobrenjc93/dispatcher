import { describe, expect, it } from "vitest";
import { readFocusTerminalFromUrl } from "../notificationNavigation";

describe("readFocusTerminalFromUrl", () => {
  it("reads the terminal a cold open was launched for", () => {
    const { terminalId } = readFocusTerminalFromUrl(
      "https://host.ts.net/?terminal=abc-123"
    );
    expect(terminalId).toBe("abc-123");
  });

  it("strips the parameter so a later reload does not jump back", () => {
    // The parameter describes one arrival. Left in place, refreshing hours
    // later would yank the user to a tab they had long since left.
    const { cleanedHref } = readFocusTerminalFromUrl("https://host.ts.net/?terminal=abc-123");
    expect(cleanedHref).toBe("https://host.ts.net/");
  });

  it("keeps other query parameters", () => {
    const { terminalId, cleanedHref } = readFocusTerminalFromUrl(
      "https://host.ts.net/?dispatcherServer=x%3A1&terminal=abc"
    );
    expect(terminalId).toBe("abc");
    expect(cleanedHref).toContain("dispatcherServer=x%3A1");
    expect(cleanedHref).not.toContain("terminal=");
  });

  it("leaves an ordinary launch untouched", () => {
    const href = "https://host.ts.net/";
    expect(readFocusTerminalFromUrl(href)).toEqual({ terminalId: null, cleanedHref: href });
  });

  it("survives something that is not a URL", () => {
    expect(readFocusTerminalFromUrl("not a url")).toEqual({
      terminalId: null,
      cleanedHref: "not a url",
    });
  });
});
