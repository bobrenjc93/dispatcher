import { describe, expect, it } from "vitest";
import {
  EMPTY_TAB_SELECTION,
  applyTabClick,
  classifyTabClick,
  commonValue,
  nextToggleValue,
  rangeBetween,
  selectionTargets,
  visibleTabOrder,
} from "../tabSelection";
import type { Project, TreeNode } from "../../types/project";
import type { TerminalSession } from "../../types/terminal";

const ORDER = ["a", "b", "c", "d", "e"];

function click(
  kind: "plain" | "range" | "range-add" | "toggle",
  terminalId: string,
  selection = EMPTY_TAB_SELECTION,
  fallbackAnchorTerminalId: string | null = null
) {
  return applyTabClick({
    selection,
    order: ORDER,
    terminalId,
    kind,
    fallbackAnchorTerminalId,
  });
}

describe("classifyTabClick", () => {
  it("does not treat a macOS right-click as a selection", () => {
    // Ctrl-click is how a context menu is opened there, so reading it as a
    // toggle would select a tab every time one was right-clicked.
    expect(classifyTabClick({ ctrlKey: true, shiftKey: false, metaKey: false, altKey: false }, { isMac: true }))
      .toBe("plain");
    expect(classifyTabClick({ ctrlKey: true, shiftKey: false, metaKey: false, altKey: false }, { isMac: false }))
      .toBe("toggle");
  });

  it("reads cmd-shift as a second range", () => {
    // Finder's way of building a non-contiguous selection: one block, then
    // another, without losing the first.
    expect(classifyTabClick({ shiftKey: true, metaKey: true, ctrlKey: false, altKey: false }, { isMac: true }))
      .toBe("range-add");
    expect(classifyTabClick({ shiftKey: true, ctrlKey: true, metaKey: false, altKey: false }, { isMac: false }))
      .toBe("range-add");
    // Ctrl-shift is still a right-click on macOS, so it must not select.
    expect(classifyTabClick({ shiftKey: true, ctrlKey: true, metaKey: false, altKey: false }, { isMac: true }))
      .toBe("range");
  });

  it("reads shift as a range and cmd as a toggle", () => {
    expect(classifyTabClick({ shiftKey: true, ctrlKey: false, metaKey: false, altKey: false }, { isMac: true }))
      .toBe("range");
    expect(classifyTabClick({ metaKey: true, shiftKey: false, ctrlKey: false, altKey: false }, { isMac: true }))
      .toBe("toggle");
    expect(classifyTabClick({ shiftKey: false, ctrlKey: false, metaKey: false, altKey: false }, { isMac: true }))
      .toBe("plain");
  });
});

describe("rangeBetween", () => {
  it("covers the run either way round", () => {
    expect(rangeBetween(ORDER, "b", "d")).toEqual(["b", "c", "d"]);
    expect(rangeBetween(ORDER, "d", "b")).toEqual(["b", "c", "d"]);
    expect(rangeBetween(ORDER, "c", "c")).toEqual(["c"]);
  });

  it("falls back to the clicked tab when the anchor is gone", () => {
    // The anchor's tab can be closed, or its project collapsed, between the
    // two clicks. One tab beats a range measured from nowhere.
    expect(rangeBetween(ORDER, "gone", "d")).toEqual(["d"]);
    expect(rangeBetween(ORDER, "b", "gone")).toEqual([]);
  });
});

describe("applyTabClick", () => {
  it("selects a range from the tab you were on", () => {
    // Nothing is explicitly selected yet, but you are looking at a tab, and
    // shift-clicking a second one plainly means "these two".
    expect(click("range", "d", EMPTY_TAB_SELECTION, "b")).toEqual({
      terminalIds: ["b", "c", "d"],
      anchorTerminalId: "b",
    });
  });

  it("re-measures a range from the same anchor rather than growing the last one", () => {
    const first = click("range", "d", EMPTY_TAB_SELECTION, "b");
    const second = applyTabClick({
      selection: first,
      order: ORDER,
      terminalId: "c",
      kind: "range",
      fallbackAnchorTerminalId: "b",
    });
    expect(second.terminalIds).toEqual(["b", "c"]);
    expect(second.anchorTerminalId).toBe("b");
  });

  it("adds and removes individual tabs, keeping sidebar order", () => {
    let selection = click("toggle", "d", EMPTY_TAB_SELECTION, "b");
    expect(selection.terminalIds).toEqual(["b", "d"]);

    selection = applyTabClick({
      selection,
      order: ORDER,
      terminalId: "a",
      kind: "toggle",
      fallbackAnchorTerminalId: "b",
    });
    expect(selection.terminalIds).toEqual(["a", "b", "d"]);

    selection = applyTabClick({
      selection,
      order: ORDER,
      terminalId: "b",
      kind: "toggle",
      fallbackAnchorTerminalId: "b",
    });
    expect(selection.terminalIds).toEqual(["a", "d"]);
  });

  it("keeps earlier blocks when a second range is added", () => {
    const order = ["a", "b", "c", "d", "e", "f", "g"];
    // Block one: a-b. Then jump to e and extend to g, keeping a-b.
    let selection = applyTabClick({
      selection: EMPTY_TAB_SELECTION,
      order,
      terminalId: "b",
      kind: "range",
      fallbackAnchorTerminalId: "a",
    });
    selection = applyTabClick({
      selection,
      order,
      terminalId: "e",
      kind: "toggle",
      fallbackAnchorTerminalId: "a",
    });
    expect(selection.terminalIds).toEqual(["a", "b", "e"]);

    selection = applyTabClick({
      selection,
      order,
      terminalId: "g",
      kind: "range-add",
      fallbackAnchorTerminalId: "a",
    });
    expect(selection.terminalIds).toEqual(["a", "b", "e", "f", "g"]);
  });

  it("does not duplicate tabs an added range overlaps", () => {
    const selection = applyTabClick({
      selection: { terminalIds: ["b", "c"], anchorTerminalId: "b" },
      order: ORDER,
      terminalId: "d",
      kind: "range-add",
      fallbackAnchorTerminalId: null,
    });
    expect(selection.terminalIds).toEqual(["b", "c", "d"]);
  });

  it("clears the selection on an ordinary click", () => {
    const selection = click("range", "d", EMPTY_TAB_SELECTION, "b");
    expect(click("plain", "a", selection, "b")).toEqual({
      terminalIds: [],
      anchorTerminalId: "a",
    });
  });

  it("survives a first click with nothing active", () => {
    expect(click("range", "c")).toEqual({ terminalIds: ["c"], anchorTerminalId: "c" });
    expect(click("toggle", "c")).toEqual({ terminalIds: ["c"], anchorTerminalId: "c" });
  });
});

describe("selectionTargets", () => {
  it("acts on the whole selection from inside it, and on one tab from outside", () => {
    const selection = { terminalIds: ["b", "c"], anchorTerminalId: "b" };
    expect(selectionTargets(selection, "c")).toEqual(["b", "c"]);
    // Right-clicking elsewhere is not a way to operate on tabs you are not
    // pointing at.
    expect(selectionTargets(selection, "e")).toEqual(["e"]);
    expect(selectionTargets(EMPTY_TAB_SELECTION, "e")).toEqual(["e"]);
  });
});

describe("nextToggleValue", () => {
  it("turns a setting on unless every tab already has it", () => {
    // Choosing Pin Gray for eight tabs should leave eight pinned, not seven
    // pinned and one unpinned because that one already was.
    expect(nextToggleValue([false, false])).toBe(true);
    expect(nextToggleValue([true, false])).toBe(true);
    expect(nextToggleValue([true, true])).toBe(false);
    expect(nextToggleValue([])).toBe(false);
  });
});

describe("commonValue", () => {
  it("reports a shared value and nothing for a disagreement", () => {
    expect(commonValue([5, 5, 5])).toBe(5);
    expect(commonValue([5, 9])).toBeUndefined();
    expect(commonValue([undefined, undefined])).toBeUndefined();
    expect(commonValue([])).toBeUndefined();
  });
});

describe("visibleTabOrder", () => {
  const sessions = {
    t1: {} as TerminalSession,
    t2: {} as TerminalSession,
    t3: {} as TerminalSession,
  };

  function fixture(secondExpanded: boolean) {
    const projects: Record<string, Project> = {
      p1: { id: "p1", name: "One", cwd: "/", rootGroupId: "r1", expanded: true },
      p2: { id: "p2", name: "Two", cwd: "/", rootGroupId: "r2", expanded: secondExpanded },
    };
    const nodes: Record<string, TreeNode> = {
      r1: { id: "r1", type: "group", name: "One", parentId: null, children: ["n1", "n2"] },
      r2: { id: "r2", type: "group", name: "Two", parentId: null, children: ["n3"] },
      n1: { id: "n1", type: "terminal", name: "a", parentId: "r1", terminalId: "t1" },
      n2: { id: "n2", type: "terminal", name: "b", parentId: "r1", terminalId: "t2" },
      n3: { id: "n3", type: "terminal", name: "c", parentId: "r2", terminalId: "t3" },
    };
    return { projects, projectOrder: ["p1", "p2"], nodes, sessions };
  }

  it("lists tabs top to bottom across projects", () => {
    expect(visibleTabOrder(fixture(true))).toEqual(["t1", "t2", "t3"]);
  });

  it("leaves out a collapsed project", () => {
    // A range has to cover what you can see, or shift-click quietly takes in
    // tabs that are not on screen.
    expect(visibleTabOrder(fixture(false))).toEqual(["t1", "t2"]);
  });
});
