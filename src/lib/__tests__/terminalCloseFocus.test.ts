import { describe, expect, it } from "vitest";
import type { LayoutNode } from "../../types/layout";
import { resolveTerminalCloseFocusTarget } from "../terminalCloseFocus";

function leaf(terminalId: string): LayoutNode {
  return { type: "terminal", id: `leaf-${terminalId}`, terminalId };
}

function split(first: LayoutNode, second: LayoutNode): LayoutNode {
  return {
    type: "split",
    id: "split",
    direction: "horizontal",
    ratio: 0.5,
    first,
    second,
  };
}

describe("resolveTerminalCloseFocusTarget", () => {
  it("focuses the visible sidebar tab underneath a closing tmux pane tab", () => {
    const target = resolveTerminalCloseFocusTarget({
      closingTerminalId: "tmux-pane",
      activeTerminalId: "tmux-pane",
      layouts: {
        "tmux-window": leaf("tmux-pane"),
        "local-under": leaf("local-under"),
        "local-after": leaf("local-after"),
      },
      sidebarTerminals: [
        { terminalId: "tmux-window", projectId: "project" },
        { terminalId: "local-under", projectId: "project" },
        { terminalId: "local-after", projectId: "project" },
      ],
      resolvePreferredTerminalFocus: (terminalId) => `${terminalId}:preferred`,
    });

    expect(target).toEqual({
      terminalId: "local-under:preferred",
      projectId: "project",
      reason: "adjacent-tab",
    });
  });

  it("falls back to the visible sidebar tab above when closing the last tab", () => {
    const target = resolveTerminalCloseFocusTarget({
      closingTerminalId: "tmux-pane",
      activeTerminalId: "tmux-pane",
      layouts: {
        "local-above": leaf("local-above"),
        "tmux-window": leaf("tmux-pane"),
      },
      sidebarTerminals: [
        { terminalId: "local-above", projectId: "project" },
        { terminalId: "tmux-window", projectId: "project" },
      ],
    });

    expect(target).toEqual({
      terminalId: "local-above",
      projectId: "project",
      reason: "adjacent-tab",
    });
  });

  it("focuses the sibling pane when closing an active split pane", () => {
    const target = resolveTerminalCloseFocusTarget({
      closingTerminalId: "right-pane",
      activeTerminalId: "right-pane",
      layouts: {
        "tmux-window": split(leaf("left-pane"), leaf("right-pane")),
      },
      sidebarTerminals: [
        { terminalId: "tmux-window", projectId: "project" },
      ],
    });

    expect(target).toEqual({
      terminalId: "left-pane",
      reason: "sibling-pane",
    });
  });

  it("does not move focus when closing a non-active split pane", () => {
    const target = resolveTerminalCloseFocusTarget({
      closingTerminalId: "right-pane",
      activeTerminalId: "left-pane",
      layouts: {
        "tmux-window": split(leaf("left-pane"), leaf("right-pane")),
      },
      sidebarTerminals: [
        { terminalId: "tmux-window", projectId: "project" },
      ],
    });

    expect(target).toBeNull();
  });
});
