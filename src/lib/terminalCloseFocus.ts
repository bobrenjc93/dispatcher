import type { LayoutNode } from "../types/layout";
import { findLayoutKeyForTerminal, findSiblingTerminalId } from "./layoutUtils";

export interface SidebarTerminalRef {
  terminalId: string;
  projectId: string;
}

export interface TerminalCloseFocusTarget {
  terminalId: string;
  projectId?: string;
  reason: "adjacent-tab" | "sibling-pane";
}

export function resolveTerminalCloseFocusTarget(options: {
  closingTerminalId: string;
  activeTerminalId: string | null;
  layouts: Record<string, LayoutNode>;
  sidebarTerminals: readonly SidebarTerminalRef[];
  resolvePreferredTerminalFocus?: (terminalId: string) => string;
}): TerminalCloseFocusTarget | null {
  const {
    activeTerminalId,
    closingTerminalId,
    layouts,
    sidebarTerminals,
    resolvePreferredTerminalFocus = (terminalId) => terminalId,
  } = options;
  const layoutKey = findLayoutKeyForTerminal(layouts, closingTerminalId);
  if (!layoutKey) {
    return null;
  }

  const layout = layouts[layoutKey];
  if (layout && layout.type !== "terminal") {
    if (activeTerminalId !== closingTerminalId) {
      return null;
    }

    const siblingTerminalId = findSiblingTerminalId(layout, closingTerminalId);
    return siblingTerminalId
      ? {
        terminalId: resolvePreferredTerminalFocus(siblingTerminalId),
        reason: "sibling-pane",
      }
      : null;
  }

  const activeTabRootTerminalId = activeTerminalId
    ? findLayoutKeyForTerminal(layouts, activeTerminalId) ?? activeTerminalId
    : null;
  if (activeTabRootTerminalId !== layoutKey) {
    return null;
  }

  const currentIndex = sidebarTerminals.findIndex((terminal) => terminal.terminalId === layoutKey);
  if (currentIndex === -1) {
    return null;
  }

  // Match the normal Dispatcher tab behavior: prefer the visible tab directly
  // underneath the closing tab, then fall back to the one above if this was the
  // last visible tab.
  const adjacentTerminal = sidebarTerminals[currentIndex + 1] ?? sidebarTerminals[currentIndex - 1] ?? null;
  return adjacentTerminal
    ? {
      terminalId: resolvePreferredTerminalFocus(adjacentTerminal.terminalId),
      projectId: adjacentTerminal.projectId,
      reason: "adjacent-tab",
    }
    : null;
}
