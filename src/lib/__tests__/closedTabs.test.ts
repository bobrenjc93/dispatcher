import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLOSED_TAB_TTL_MS,
  MAX_CLOSED_TABS,
  closedTabId,
  expiredClosedTabs,
  forgetClosedTab,
  hiddenWindowIdsForConnection,
  isClosedTabExpired,
  listClosedTabs,
  resetClosedTabsMemory,
  rememberClosedTab,
  takeMostRecentlyClosed,
} from "../closedTabs";

const tab = (windowId: string, closedAt: number, connectionKey: string | null = "server-a") => ({
  connectionKey,
  sessionId: "control-1",
  paneIds: [],
  anchorWindowId: null,
  windowId,
  title: `tab ${windowId}`,
  closedAt,
});

const idOf = (entry: Parameters<typeof closedTabId>[0] | null) =>
  entry ? closedTabId(entry) : undefined;

describe("closed tabs", () => {
  beforeEach(() => window.localStorage.clear());

  it("reopens the most recently closed first", () => {
    rememberClosedTab(tab("@1", 100));
    rememberClosedTab(tab("@2", 200));
    rememberClosedTab(tab("@3", 150));

    expect(idOf(takeMostRecentlyClosed(300))).toBe("@2");
    expect(idOf(takeMostRecentlyClosed(300))).toBe("@3");
    expect(idOf(takeMostRecentlyClosed(300))).toBe("@1");
    expect(takeMostRecentlyClosed(300)).toBeNull();
  });

  it("steps over entries whose grace period ran out", () => {
    // Reopening should give you a tab, not a stale row that fails.
    rememberClosedTab(tab("@old", 0));
    rememberClosedTab(tab("@new", CLOSED_TAB_TTL_MS));

    expect(idOf(takeMostRecentlyClosed(CLOSED_TAB_TTL_MS + 1))).toBe("@new");
    expect(takeMostRecentlyClosed(CLOSED_TAB_TTL_MS + 1)).toBeNull();
  });

  it("hands back entries to kill once they expire", () => {
    rememberClosedTab(tab("@a", 0));
    rememberClosedTab(tab("@b", CLOSED_TAB_TTL_MS));

    expect(expiredClosedTabs(CLOSED_TAB_TTL_MS + 1).map(closedTabId))
      .toEqual(["@a"]);
    // Still listed until the caller says it actually killed the window. A
    // window nothing is attached to yet cannot be killed, and forgetting it
    // there would let the closed tab come back at the next attach.
    expect(listClosedTabs().map(closedTabId)).toEqual(["@b", "@a"]);

    forgetClosedTab(tab("@a", 0));
    expect(expiredClosedTabs(CLOSED_TAB_TTL_MS + 1)).toEqual([]);
    expect(listClosedTabs().map(closedTabId)).toEqual(["@b"]);
  });

  it("evicts past the cap and says which, so nothing is left running unremembered", () => {
    // Each entry is a live tmux window holding a process; the cap is a
    // resource bound, not a display one.
    for (let i = 0; i < MAX_CLOSED_TABS; i += 1) {
      expect(rememberClosedTab(tab(`@${i}`, i))).toEqual([]);
    }
    const evicted = rememberClosedTab(tab("@newest", 9_999));
    expect(evicted.map(closedTabId)).toEqual(["@0"]);
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
    forgetClosedTab(tab("@1", 0));
    expect(listClosedTabs().map(closedTabId)).toEqual(["@2"]);
  });

  it("expires exactly at the deadline", () => {
    expect(isClosedTabExpired(tab("@1", 0), CLOSED_TAB_TTL_MS - 1)).toBe(false);
    expect(isClosedTabExpired(tab("@1", 0), CLOSED_TAB_TTL_MS)).toBe(true);
  });

  it("still reopens when localStorage silently drops the write", () => {
    // What WebKit does when a dead instance's networking process still holds
    // the storage file: setItem returns, and nothing is there to read back.
    // The tab closed a second ago used to be gone already.
    const setItem = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {});
    try {
      rememberClosedTab(tab("@1", 100));
      rememberClosedTab(tab("@2", 200));

      expect(idOf(takeMostRecentlyClosed(300))).toBe("@2");
      expect(idOf(takeMostRecentlyClosed(300))).toBe("@1");
      expect(takeMostRecentlyClosed(300)).toBeNull();
    } finally {
      setItem.mockRestore();
    }

    // Storage working again gets the list back for the next launch.
    rememberClosedTab(tab("@3", 300));
    expect(window.localStorage.getItem("dispatcher-dev:dispatcher.closedTabs")).toContain("@3");
    expect(listClosedTabs().map(closedTabId)).toEqual(["@3"]);
  });

  it("still reopens when the write reads back and then vanishes", () => {
    // What the 2026-10-06 log showed: "remembered a closed tab" with the entry
    // read back, then "nothing left to reopen" a moment later.
    rememberClosedTab(tab("@1", 100));
    window.localStorage.removeItem("dispatcher-dev:dispatcher.closedTabs");

    expect(idOf(takeMostRecentlyClosed(200))).toBe("@1");
  });

  it("picks the list back up from storage after a restart", () => {
    rememberClosedTab(tab("@1", 100));
    resetClosedTabsMemory();

    expect(idOf(takeMostRecentlyClosed(200))).toBe("@1");
  });
});
