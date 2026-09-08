/**
 * Selecting several tabs at once.
 *
 * The sidebar's actions are per-tab, which is fine until you have twenty tabs
 * and want the same thing done to eight of them. Shift-click gives a range,
 * Cmd-click picks individuals and Cmd-shift-click adds a second range, the way
 * Finder does it, and the context menu then acts on the whole selection.
 *
 * Kept pure and separate from the components: the interesting parts are the
 * range arithmetic and what a group toggle should do when the tabs disagree,
 * and neither needs a DOM to be worth testing.
 */

import { collectVisibleTerminalRefs } from "./treeUtils";
import type { SidebarTerminalRef } from "./terminalCloseFocus";
import type { Project, TreeNode } from "../types/project";
import type { TerminalSession } from "../types/terminal";

export interface TabSelection {
  /** Explicitly selected tabs, in the order they appear in the sidebar. */
  terminalIds: string[];
  /**
   * Where the next range starts.
   *
   * Held separately from the selection because a range is measured from the
   * tab you started at, not from whichever end of the current range you
   * happen to be nearest — so extending a range twice from one anchor keeps
   * giving you ranges from that anchor.
   */
  anchorTerminalId: string | null;
}

export const EMPTY_TAB_SELECTION: TabSelection = {
  terminalIds: [],
  anchorTerminalId: null,
};

export type TabClickKind = "plain" | "range" | "range-add" | "toggle";

/**
 * What a click on a tab means.
 *
 * Ctrl is only a selection modifier away from macOS, where Ctrl-click is how
 * you open a context menu — treating it as a toggle there would select a tab
 * every time somebody right-clicked one.
 */
export function classifyTabClick(
  event: Pick<MouseEvent, "shiftKey" | "metaKey" | "ctrlKey" | "altKey">,
  options: { isMac: boolean }
): TabClickKind {
  if (event.altKey) {
    return "plain";
  }
  const toggleModifier = options.isMac ? event.metaKey : event.ctrlKey;
  if (event.shiftKey) {
    // Both modifiers means a second block, the way Finder builds a
    // non-contiguous selection: keep what is there and add this run.
    return toggleModifier ? "range-add" : "range";
  }
  if (toggleModifier) {
    return "toggle";
  }
  return "plain";
}

/** Inclusive run between two tabs, in sidebar order, whichever way round. */
export function rangeBetween(
  order: readonly string[],
  from: string,
  to: string
): string[] {
  const fromIndex = order.indexOf(from);
  const toIndex = order.indexOf(to);
  if (toIndex === -1) {
    return [];
  }
  if (fromIndex === -1) {
    // The anchor is gone — closed, or in a project that has since been
    // collapsed. One tab is a better answer than a range measured from
    // nowhere.
    return [to];
  }
  const [low, high] = fromIndex <= toIndex ? [fromIndex, toIndex] : [toIndex, fromIndex];
  return order.slice(low, high + 1);
}

function sortByOrder(terminalIds: readonly string[], order: readonly string[]): string[] {
  const rank = new Map(order.map((id, index) => [id, index]));
  // Anything the order does not know about sorts last rather than vanishing:
  // dropping it would silently shrink the selection.
  return [...terminalIds].sort(
    (a, b) => (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER)
  );
}

/**
 * What the selection already covers, treating the active tab as selected.
 *
 * With nothing explicitly selected there is still a tab you are on, and
 * shift-clicking a second one plainly means "these two". Requiring a throwaway
 * first click to establish that would be a worse answer than assuming it.
 */
function effectiveSelection(
  selection: TabSelection,
  fallbackAnchorTerminalId: string | null
): string[] {
  if (selection.terminalIds.length > 0) {
    return selection.terminalIds;
  }
  return fallbackAnchorTerminalId ? [fallbackAnchorTerminalId] : [];
}

export function applyTabClick(args: {
  selection: TabSelection;
  order: readonly string[];
  terminalId: string;
  kind: TabClickKind;
  /** Usually the active tab: where a range starts when nothing is selected. */
  fallbackAnchorTerminalId: string | null;
}): TabSelection {
  const { selection, order, terminalId, kind, fallbackAnchorTerminalId } = args;

  if (kind === "plain") {
    // An ordinary click is also how you get out of a selection.
    return { terminalIds: [], anchorTerminalId: terminalId };
  }

  const anchor = selection.anchorTerminalId ?? fallbackAnchorTerminalId;

  if (kind === "range" || kind === "range-add") {
    const range = anchor ? rangeBetween(order, anchor, terminalId) : [terminalId];
    const kept = kind === "range-add" ? effectiveSelection(selection, fallbackAnchorTerminalId) : [];
    const combined = [...kept, ...range.filter((id) => !kept.includes(id))];
    // The anchor stays put, so shift-clicking again re-measures from the same
    // place rather than growing whatever the last range happened to be.
    return {
      terminalIds: kind === "range-add" ? sortByOrder(combined, order) : range,
      anchorTerminalId: anchor ?? terminalId,
    };
  }

  const base = effectiveSelection(selection, fallbackAnchorTerminalId);
  const next = base.includes(terminalId)
    ? base.filter((id) => id !== terminalId)
    : [...base, terminalId];
  return {
    terminalIds: sortByOrder(next, order),
    anchorTerminalId: terminalId,
  };
}

/**
 * The tabs an action opened from `terminalId` should apply to.
 *
 * A tab outside the selection acts alone — right-clicking somewhere else is
 * not a way to operate on things you cannot see.
 */
export function selectionTargets(selection: TabSelection, terminalId: string): string[] {
  return selection.terminalIds.includes(terminalId) ? [...selection.terminalIds] : [terminalId];
}

/**
 * What a toggle should become across tabs that may disagree.
 *
 * Any tab lacking the setting means the intent is to turn it on: selecting
 * eight tabs and choosing Pin Gray should leave eight pinned tabs, not seven
 * pinned and one unpinned because that one already was.
 */
export function nextToggleValue(current: readonly boolean[]): boolean {
  return current.some((value) => !value);
}

/**
 * The one value shared by every tab, or undefined if they disagree.
 *
 * Used to show a setting's current value in a menu without inventing one for a
 * selection that has several.
 */
export function commonValue<T>(values: readonly T[]): T | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const [first] = values;
  return values.every((value) => value === first) ? first : undefined;
}

/**
 * Tabs as the sidebar lists them, top to bottom.
 *
 * The one list. Tab-to-tab navigation walks it too, so a shift-click measures
 * its range over exactly the sequence ⇧⌘[ and ⇧⌘] move through.
 *
 * A collapsed project contributes nothing: a range has to cover what you can
 * see, or shift-click would quietly take in tabs that are not on screen.
 * Collapsed *groups* are the exception, because that state lives in the
 * component rather than the store — groups are not part of any current
 * workflow, and a wrong range there is a visible mistake rather than a silent
 * one.
 */
export function visibleTabs(args: {
  projects: Record<string, Project>;
  projectOrder: string[];
  nodes: Record<string, TreeNode>;
  sessions: Record<string, TerminalSession>;
}): SidebarTerminalRef[] {
  const { projects, projectOrder, nodes, sessions } = args;
  const ids = projectOrder.length > 0 ? projectOrder : Object.keys(projects);
  const tabs: SidebarTerminalRef[] = [];
  for (const projectId of ids) {
    const project = projects[projectId];
    if (!project || !project.expanded) {
      continue;
    }
    for (const ref of collectVisibleTerminalRefs(nodes, project.rootGroupId, sessions)) {
      tabs.push({ terminalId: ref.terminalId, projectId });
    }
  }
  return tabs;
}

/** Just the ids, which is what a range is measured in. */
export function visibleTabOrder(args: Parameters<typeof visibleTabs>[0]): string[] {
  return visibleTabs(args).map((tab) => tab.terminalId);
}
