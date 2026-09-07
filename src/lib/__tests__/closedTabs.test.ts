import { beforeEach, describe, expect, it } from "vitest";
import {
  CLOSED_TAB_TTL_MS,
  MAX_CLOSED_TABS,
  expiredClosedTabs,
  forgetClosedTab,
  hiddenWindowIdsForConnection,
  isClosedTabExpired,
  listClosedTabs,
  rememberClosedTab,
  takeMostRecentlyClosed,
} from "../closedTabs";

const tab = (windowId: string, closedAt: number, connectionKey: string | null = "server-a") => ({
  connectionKey,
  sessionId: "control-1",
  paneIds: [],
  windowId,
  title: `tab ${windowId}`,
  closedAt,
});

describe("closed tabs", () => {
  beforeEach(() => window.localStorage.clear());

  it("reopens the most recently closed first", () => {
    rememberClosedTab(tab("@1", 100));
    rememberClosedTab(tab("@2", 200));
    rememberClosedTab(tab("@3", 150));

    expect(takeMostRecentlyClosed(300)?.windowId).toBe("@2");
    expect(takeMostRecentlyClosed(300)?.windowId).toBe("@3");
    expect(takeMostRecentlyClosed(300)?.windowId).toBe("@1");
    expect(takeMostRecentlyClosed(300)).toBeNull();
  });

  it("steps over entries whose grace period ran out", () => {
    // Reopening should give you a tab, not a stale row that fails.
    rememberClosedTab(tab("@old", 0));
    rememberClosedTab(tab("@new", CLOSED_TAB_TTL_MS));

    expect(takeMostRecentlyClosed(CLOSED_TAB_TTL_MS + 1)?.windowId).toBe("@new");
    expect(takeMostRecentlyClosed(CLOSED_TAB_TTL_MS + 1)).toBeNull();
  });

  it("hands back entries to kill once they expire", () => {
    rememberClosedTab(tab("@a", 0));
    rememberClosedTab(tab("@b", CLOSED_TAB_TTL_MS));

    expect(expiredClosedTabs(CLOSED_TAB_TTL_MS + 1).map((entry) => entry.windowId))
      .toEqual(["@a"]);
    // Still listed until the caller says it actually killed the window. A
    // window nothing is attached to yet cannot be killed, and forgetting it
    // there would let the closed tab come back at the next attach.
    expect(listClosedTabs().map((entry) => entry.windowId)).toEqual(["@b", "@a"]);

    forgetClosedTab(tab("@a", 0));
    expect(expiredClosedTabs(CLOSED_TAB_TTL_MS + 1)).toEqual([]);
    expect(listClosedTabs().map((entry) => entry.windowId)).toEqual(["@b"]);
  });

  it("evicts past the cap and says which, so nothing is left running unremembered", () => {
    // Each entry is a live tmux window holding a process; the cap is a
    // resource bound, not a display one.
    for (let i = 0; i < MAX_CLOSED_TABS; i += 1) {
      expect(rememberClosedTab(tab(`@${i}`, i))).toEqual([]);
    }
    const evicted = rememberClosedTab(tab("@newest", 9_999));
    expect(evicted.map((entry) => entry.windowId)).toEqual(["@0"]);
    expect(listClosedTabs()).toHaveLength(MAX_CLOSED_TABS);
  });

  it("replaces an entry for a window rather than duplicating it", () => {
    rememberClosedTab(tab("@1", 100));
    rememberClosedTab(tab("@1", 500));
    expect(listClosedTabs()).toHaveLength(1);
    expect(listClosedTabs()[0].closedAt).toBe(500);
  });

  it("keeps windows hidden per tmux server, not globally", () => {
    // Window ids are recycled between server lifetimes, so an id alone can
    // hide — or resurrect — the wrong window.
    rememberClosedTab(tab("@1", 100, "server-a"));
    rememberClosedTab(tab("@1", 100, "server-b"));

    expect(hiddenWindowIdsForConnection("server-a")).toEqual(["@1"]);
    expect(hiddenWindowIdsForConnection("server-c")).toEqual([]);
  });

  it("survives a corrupt entry without taking the app down", () => {
    window.localStorage.setItem("dispatcher-dev:dispatcher.closedTabs", "{not json");
    expect(listClosedTabs()).toEqual([]);
  });

  it("forgets a specific window", () => {
    rememberClosedTab(tab("@1", 100));
    rememberClosedTab(tab("@2", 200));
    forgetClosedTab({ connectionKey: "server-a", windowId: "@1" });
    expect(listClosedTabs().map((e) => e.windowId)).toEqual(["@2"]);
  });

  it("expires exactly at the deadline", () => {
    expect(isClosedTabExpired(tab("@1", 0), CLOSED_TAB_TTL_MS - 1)).toBe(false);
    expect(isClosedTabExpired(tab("@1", 0), CLOSED_TAB_TTL_MS)).toBe(true);
  });
});
