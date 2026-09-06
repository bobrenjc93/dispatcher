import { beforeEach, describe, expect, it } from "vitest";
import {
  readFocusTerminalFromUrl,
  resolveNotificationFocusTarget,
} from "../notificationNavigation";
import { useLayoutStore } from "../../stores/useLayoutStore";
import { useTerminalStore } from "../../stores/useTerminalStore";

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

describe("resolveNotificationFocusTarget", () => {
  beforeEach(() => {
    useLayoutStore.setState({ layouts: {} });
    useTerminalStore.setState({ sessions: {}, activeTerminalId: null });
  });

  it("focuses the pane inside a tmux tab, not the window placeholder", () => {
    // A notification names the tab root. For a tmux tab that is the window
    // terminal, which is never rendered — focusing it activates a tab with
    // nothing in it, which is what made tapping appear to do nothing.
    useLayoutStore.setState({
      layouts: { win: { type: "terminal", id: "p", terminalId: "pane" } as never },
    });
    useTerminalStore.setState({ sessions: { pane: {} as never } });

    expect(resolveNotificationFocusTarget("win")).toBe("pane");
  });

  it("returns to the pane that was already active in a split", () => {
    useLayoutStore.setState({
      layouts: {
        win: {
          type: "split",
          direction: "horizontal",
          ratio: 0.5,
          first: { type: "terminal", id: "l", terminalId: "left" },
          second: { type: "terminal", id: "r", terminalId: "right" },
        } as never,
      },
    });
    useTerminalStore.setState({
      sessions: { left: {} as never, right: {} as never },
      activeTerminalId: "right",
    });

    expect(resolveNotificationFocusTarget("win")).toBe("right");
  });

  it("falls back to the tab root when there is no layout for it", () => {
    // A notification can outlive its tab, and on a cold start the workspace
    // may not have arrived yet.
    expect(resolveNotificationFocusTarget("gone")).toBe("gone");
  });

  it("ignores layout entries with no session behind them", () => {
    useLayoutStore.setState({
      layouts: { win: { type: "terminal", id: "s", terminalId: "stale" } as never },
    });
    expect(resolveNotificationFocusTarget("win")).toBe("win");
  });
});
