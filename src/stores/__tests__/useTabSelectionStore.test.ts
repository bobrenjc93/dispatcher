import { beforeEach, describe, expect, it } from "vitest";
import { useTabSelectionStore } from "../useTabSelectionStore";

const ORDER = ["a", "b", "c", "d"];

describe("useTabSelectionStore", () => {
  beforeEach(() => {
    useTabSelectionStore.getState().clear();
  });

  it("builds a selection from clicks", () => {
    useTabSelectionStore.getState().clickTab({
      order: ORDER,
      terminalId: "c",
      kind: "range",
      fallbackAnchorTerminalId: "a",
    });
    expect(useTabSelectionStore.getState().terminalIds).toEqual(["a", "b", "c"]);
  });

  it("drops tabs that no longer exist", () => {
    useTabSelectionStore.getState().clickTab({
      order: ORDER,
      terminalId: "c",
      kind: "range",
      fallbackAnchorTerminalId: "a",
    });
    useTabSelectionStore.getState().prune(["a", "c"]);
    expect(useTabSelectionStore.getState().terminalIds).toEqual(["a", "c"]);

    useTabSelectionStore.getState().prune(["c"]);
    // The anchor went with it, so the next range starts from the active tab
    // rather than from a tab that has been closed.
    expect(useTabSelectionStore.getState().anchorTerminalId).toBeNull();
  });

  it("hands the anchor back to the active tab when you navigate away", () => {
    // Move by ⇧⌘[ and then shift-click: the range has to start where you now
    // are, not at whichever tab you last clicked.
    useTabSelectionStore.getState().clickTab({
      order: ORDER,
      terminalId: "d",
      kind: "plain",
      fallbackAnchorTerminalId: null,
    });
    expect(useTabSelectionStore.getState().anchorTerminalId).toBe("d");

    useTabSelectionStore.getState().releaseAnchor();
    expect(useTabSelectionStore.getState().anchorTerminalId).toBeNull();

    useTabSelectionStore.getState().clickTab({
      order: ORDER,
      terminalId: "c",
      kind: "range",
      // Where ⇧⌘[ left the user.
      fallbackAnchorTerminalId: "a",
    });
    expect(useTabSelectionStore.getState().terminalIds).toEqual(["a", "b", "c"]);
  });

  it("keeps a selection when only the anchor is released", () => {
    useTabSelectionStore.getState().clickTab({
      order: ORDER,
      terminalId: "c",
      kind: "range",
      fallbackAnchorTerminalId: "a",
    });
    useTabSelectionStore.getState().releaseAnchor();
    // Looking at another tab is not a reason to lose what was picked out.
    expect(useTabSelectionStore.getState().terminalIds).toEqual(["a", "b", "c"]);
  });

  it("keeps the same state object when nothing was pruned", () => {
    // Pruning runs on every store change, and a fresh array each time would
    // re-render every tab in the sidebar for nothing.
    useTabSelectionStore.getState().clickTab({
      order: ORDER,
      terminalId: "b",
      kind: "toggle",
      fallbackAnchorTerminalId: null,
    });
    const before = useTabSelectionStore.getState().terminalIds;
    useTabSelectionStore.getState().prune(ORDER);
    expect(useTabSelectionStore.getState().terminalIds).toBe(before);
  });
});
