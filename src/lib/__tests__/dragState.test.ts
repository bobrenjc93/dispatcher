import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerDragCallbacks,
  shouldIgnoreDragStartTarget,
  startDrag,
} from "../dragState";

function pointerEvent(type: string, clientX: number, clientY: number) {
  return new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
  });
}

function finishPointerDrag() {
  document.dispatchEvent(pointerEvent("pointerup", 0, 0));
}

function mockRect(element: HTMLElement, top: number, height: number) {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: top,
    top,
    left: 0,
    right: 200,
    bottom: top + height,
    width: 200,
    height,
    toJSON: () => ({}),
  });
}

describe("dragState", () => {
  afterEach(() => {
    finishPointerDrag();
    registerDragCallbacks({
      onMoveTerminal: () => {},
      onReorderChild: () => {},
      onReorderProject: () => {},
    });
    vi.restoreAllMocks();
    document.body.className = "";
    document.body.removeAttribute("style");
    document.body.innerHTML = "";
  });

  it("suppresses document text selection after a sidebar drag activates", () => {
    document.body.style.userSelect = "text";
    const element = document.createElement("div");
    document.body.append(element);

    startDrag({ type: "project", projectId: "project" }, 0, 0, element);

    expect(document.body.classList.contains("sidebar-dragging")).toBe(false);
    expect(document.body.style.userSelect).toBe("text");

    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => element),
    });
    document.dispatchEvent(pointerEvent("pointermove", 0, 10));

    expect(document.body.classList.contains("sidebar-dragging")).toBe(true);
    expect(document.body.style.userSelect).toBe("none");

    const selectStart = new Event("selectstart", {
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(selectStart);
    expect(selectStart.defaultPrevented).toBe(true);

    finishPointerDrag();

    expect(document.body.classList.contains("sidebar-dragging")).toBe(false);
    expect(document.body.style.userSelect).toBe("text");
  });

  it("does not start sidebar drags from interactive controls", () => {
    const row = document.createElement("div");
    const button = document.createElement("button");
    const input = document.createElement("input");
    row.append(button, input);

    expect(shouldIgnoreDragStartTarget(row)).toBe(false);
    expect(shouldIgnoreDragStartTarget(button)).toBe(true);
    expect(shouldIgnoreDragStartTarget(input)).toBe(true);
  });

  it("still reorders terminals after selection suppression is active", () => {
    const dragged = document.createElement("div");
    dragged.dataset.nodeId = "dragged-node";
    dragged.dataset.projectId = "project";
    dragged.dataset.parentNodeId = "root";
    const target = document.createElement("div");
    target.dataset.nodeId = "target-node";
    target.dataset.projectId = "project";
    target.dataset.parentNodeId = "root";
    document.body.append(dragged, target);
    mockRect(target, 100, 20);

    const onReorderChild = vi.fn();
    registerDragCallbacks({
      onMoveTerminal: vi.fn(),
      onReorderChild,
      onReorderProject: vi.fn(),
    });
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => target),
    });

    startDrag({
      type: "terminal",
      terminalId: "terminal",
      projectId: "project",
      nodeId: "dragged-node",
    }, 0, 0, dragged);
    document.dispatchEvent(pointerEvent("pointermove", 0, 120));
    document.dispatchEvent(pointerEvent("pointerup", 0, 120));

    expect(onReorderChild).toHaveBeenCalledWith("root", "dragged-node", "target-node", "after");
  });

  it("reorders terminals from a touch long press", () => {
    // A finger cannot start a drag by moving: the sidebar scrolls, so the
    // browser claims the gesture and fires pointercancel before any movement
    // threshold is reached. Pressing and holding is what starts a touch drag.
    vi.useFakeTimers();
    try {
      const dragged = document.createElement("div");
      dragged.dataset.nodeId = "dragged-node";
      dragged.dataset.projectId = "project";
      dragged.dataset.parentNodeId = "root";
      const target = document.createElement("div");
      target.dataset.nodeId = "target-node";
      target.dataset.projectId = "project";
      target.dataset.parentNodeId = "root";
      document.body.append(dragged, target);
      mockRect(target, 100, 20);

      const onReorderChild = vi.fn();
      registerDragCallbacks({
        onMoveTerminal: vi.fn(),
        onReorderChild,
        onReorderProject: vi.fn(),
      });
      Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        value: vi.fn(() => target),
      });

      startDrag({
        type: "terminal",
        terminalId: "terminal",
        projectId: "project",
        nodeId: "dragged-node",
      }, 0, 0, dragged, "touch");

      // Held still, so the press alone becomes a drag — no movement needed,
      // because movement is how the browser decides to scroll instead.
      vi.advanceTimersByTime(400);
      expect(dragged.classList.contains("is-dragging")).toBe(true);

      document.dispatchEvent(pointerEvent("pointermove", 0, 120));
      document.dispatchEvent(pointerEvent("pointerup", 0, 120));

      expect(onReorderChild).toHaveBeenCalledWith("root", "dragged-node", "target-node", "after");
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a whole selection together, in order", () => {
    // Shift-clicking several rows and dragging one of them should move all of
    // them: picking up a selection and having one row come away is not what a
    // list does anywhere else.
    const first = document.createElement("div");
    first.dataset.nodeId = "first-node";
    first.dataset.projectId = "project";
    first.dataset.parentNodeId = "root";
    const second = document.createElement("div");
    second.dataset.nodeId = "second-node";
    second.dataset.projectId = "project";
    second.dataset.parentNodeId = "root";
    const target = document.createElement("div");
    target.dataset.nodeId = "target-node";
    target.dataset.projectId = "project";
    target.dataset.parentNodeId = "root";
    document.body.append(first, second, target);
    mockRect(target, 100, 20);

    const onReorderChild = vi.fn();
    registerDragCallbacks({
      onMoveTerminal: vi.fn(),
      onReorderChild,
      onReorderProject: vi.fn(),
    });
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => target),
    });

    startDrag(
      {
        type: "terminal",
        terminalId: "first",
        projectId: "project",
        nodeId: "first-node",
        nodes: [
          { terminalId: "first", nodeId: "first-node" },
          { terminalId: "second", nodeId: "second-node" },
        ],
      },
      0,
      0,
      first
    );

    document.dispatchEvent(pointerEvent("pointermove", 0, 120));
    // Both rows show as moving, not just the one under the pointer.
    expect(first.classList.contains("is-dragging")).toBe(true);
    expect(second.classList.contains("is-dragging")).toBe(true);

    document.dispatchEvent(pointerEvent("pointerup", 0, 120));

    expect(onReorderChild.mock.calls).toEqual([
      ["root", "first-node", "target-node", "after"],
      ["root", "second-node", "first-node", "after"],
    ]);
    expect(second.classList.contains("is-dragging")).toBe(false);
  });

  it("ignores a selection dropped on one of its own rows", () => {
    const dragged = document.createElement("div");
    dragged.dataset.nodeId = "dragged-node";
    dragged.dataset.projectId = "project";
    dragged.dataset.parentNodeId = "root";
    const alsoSelected = document.createElement("div");
    alsoSelected.dataset.nodeId = "also-selected";
    alsoSelected.dataset.projectId = "project";
    alsoSelected.dataset.parentNodeId = "root";
    document.body.append(dragged, alsoSelected);
    mockRect(alsoSelected, 100, 20);

    const onReorderChild = vi.fn();
    registerDragCallbacks({
      onMoveTerminal: vi.fn(),
      onReorderChild,
      onReorderProject: vi.fn(),
    });
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => alsoSelected),
    });

    startDrag(
      {
        type: "terminal",
        terminalId: "dragged",
        projectId: "project",
        nodeId: "dragged-node",
        nodes: [
          { terminalId: "dragged", nodeId: "dragged-node" },
          { terminalId: "also", nodeId: "also-selected" },
        ],
      },
      0,
      0,
      dragged
    );
    document.dispatchEvent(pointerEvent("pointermove", 0, 120));
    document.dispatchEvent(pointerEvent("pointerup", 0, 120));

    expect(onReorderChild).not.toHaveBeenCalled();
  });

  it("opens the menu when a touch is held and lifted without moving", () => {
    // A phone has no right button, so the long press has to reach the same
    // menu — otherwise Push on Inactivity and the rest are desktop-only.
    vi.useFakeTimers();
    try {
      const dragged = document.createElement("div");
      dragged.dataset.nodeId = "dragged-node";
      dragged.dataset.projectId = "project";
      dragged.dataset.parentNodeId = "root";
      document.body.append(dragged);

      const onReorderChild = vi.fn();
      registerDragCallbacks({
        onMoveTerminal: vi.fn(),
        onReorderChild,
        onReorderProject: vi.fn(),
      });
      Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        value: vi.fn(() => dragged),
      });

      const onPressWithoutMove = vi.fn();
      startDrag(
        { type: "terminal", terminalId: "terminal", projectId: "project", nodeId: "dragged-node" },
        30,
        40,
        dragged,
        "touch",
        { onPressWithoutMove }
      );

      vi.advanceTimersByTime(400);
      // A finger never holds perfectly still; a couple of pixels is the same
      // gesture.
      document.dispatchEvent(pointerEvent("pointermove", 32, 41));
      document.dispatchEvent(pointerEvent("pointerup", 32, 41));

      expect(onPressWithoutMove).toHaveBeenCalledWith(32, 41);
      expect(onReorderChild).not.toHaveBeenCalled();
      expect(dragged.classList.contains("is-dragging")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still reorders when a held touch goes somewhere", () => {
    vi.useFakeTimers();
    try {
      const dragged = document.createElement("div");
      dragged.dataset.nodeId = "dragged-node";
      dragged.dataset.projectId = "project";
      dragged.dataset.parentNodeId = "root";
      const target = document.createElement("div");
      target.dataset.nodeId = "target-node";
      target.dataset.projectId = "project";
      target.dataset.parentNodeId = "root";
      document.body.append(dragged, target);
      mockRect(target, 100, 20);

      const onReorderChild = vi.fn();
      registerDragCallbacks({
        onMoveTerminal: vi.fn(),
        onReorderChild,
        onReorderProject: vi.fn(),
      });
      Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        value: vi.fn(() => target),
      });

      const onPressWithoutMove = vi.fn();
      startDrag(
        { type: "terminal", terminalId: "terminal", projectId: "project", nodeId: "dragged-node" },
        0,
        0,
        dragged,
        "touch",
        { onPressWithoutMove }
      );

      vi.advanceTimersByTime(400);
      document.dispatchEvent(pointerEvent("pointermove", 0, 120));
      document.dispatchEvent(pointerEvent("pointerup", 0, 120));

      expect(onReorderChild).toHaveBeenCalledWith("root", "dragged-node", "target-node", "after");
      expect(onPressWithoutMove).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a touch that moves before the long press scroll instead of dragging", () => {
    vi.useFakeTimers();
    try {
      const dragged = document.createElement("div");
      dragged.dataset.nodeId = "dragged-node";
      dragged.dataset.projectId = "project";
      dragged.dataset.parentNodeId = "root";
      const target = document.createElement("div");
      target.dataset.nodeId = "target-node";
      target.dataset.projectId = "project";
      target.dataset.parentNodeId = "root";
      document.body.append(dragged, target);
      mockRect(target, 100, 20);

      const onReorderChild = vi.fn();
      registerDragCallbacks({
        onMoveTerminal: vi.fn(),
        onReorderChild,
        onReorderProject: vi.fn(),
      });
      Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        value: vi.fn(() => target),
      });

      startDrag({
        type: "terminal",
        terminalId: "terminal",
        projectId: "project",
        nodeId: "dragged-node",
      }, 0, 0, dragged, "touch");

      // Moved straight away: that is a scroll, and it must not reorder.
      document.dispatchEvent(pointerEvent("pointermove", 0, 60));
      vi.advanceTimersByTime(400);
      document.dispatchEvent(pointerEvent("pointermove", 0, 120));
      document.dispatchEvent(pointerEvent("pointerup", 0, 120));

      expect(onReorderChild).not.toHaveBeenCalled();
      expect(document.body.classList.contains("sidebar-dragging")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases the scroll blocker when a live touch drag is cancelled", () => {
    // A touch drag holds a non-passive touchmove listener so the list stays
    // put under the finger. There is no mouseup fallback on touch, so if a
    // cancelled drag kept that listener the whole app would stop scrolling.
    vi.useFakeTimers();
    try {
      const dragged = document.createElement("div");
      dragged.dataset.nodeId = "dragged-node";
      dragged.dataset.projectId = "project";
      document.body.append(dragged);

      startDrag({
        type: "terminal",
        terminalId: "terminal",
        projectId: "project",
        nodeId: "dragged-node",
      }, 0, 0, dragged, "touch");
      vi.advanceTimersByTime(400);
      expect(dragged.classList.contains("is-dragging")).toBe(true);

      document.dispatchEvent(pointerEvent("pointercancel", 0, 0));

      const touchMove = new Event("touchmove", { bubbles: true, cancelable: true });
      document.dispatchEvent(touchMove);
      expect(touchMove.defaultPrevented).toBe(false);
      expect(document.body.classList.contains("sidebar-dragging")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("completes an active drag from the mouseup fallback after pointercancel", () => {
    const dragged = document.createElement("div");
    dragged.dataset.nodeId = "dragged-node";
    dragged.dataset.projectId = "project";
    dragged.dataset.parentNodeId = "root";
    const target = document.createElement("div");
    target.dataset.nodeId = "target-node";
    target.dataset.projectId = "project";
    target.dataset.parentNodeId = "root";
    document.body.append(dragged, target);
    mockRect(target, 100, 20);

    const onReorderChild = vi.fn();
    registerDragCallbacks({
      onMoveTerminal: vi.fn(),
      onReorderChild,
      onReorderProject: vi.fn(),
    });
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => target),
    });

    startDrag({
      type: "terminal",
      terminalId: "terminal",
      projectId: "project",
      nodeId: "dragged-node",
    }, 0, 0, dragged);
    document.dispatchEvent(pointerEvent("pointermove", 0, 120));
    document.dispatchEvent(pointerEvent("pointercancel", 0, 120));
    document.dispatchEvent(pointerEvent("mouseup", 0, 120));

    expect(onReorderChild).toHaveBeenCalledWith("root", "dragged-node", "target-node", "after");
  });

  it("keeps registered callbacks available after the drag module is reloaded", async () => {
    const dragged = document.createElement("div");
    dragged.dataset.nodeId = "dragged-node";
    dragged.dataset.projectId = "project";
    dragged.dataset.parentNodeId = "root";
    const target = document.createElement("div");
    target.dataset.nodeId = "target-node";
    target.dataset.projectId = "project";
    target.dataset.parentNodeId = "root";
    document.body.append(dragged, target);
    mockRect(target, 100, 20);

    const onReorderChild = vi.fn();
    registerDragCallbacks({
      onMoveTerminal: vi.fn(),
      onReorderChild,
      onReorderProject: vi.fn(),
    });
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => target),
    });

    vi.resetModules();
    const reloadedDragState = await import("../dragState");
    reloadedDragState.startDrag({
      type: "terminal",
      terminalId: "terminal",
      projectId: "project",
      nodeId: "dragged-node",
    }, 0, 0, dragged);
    document.dispatchEvent(pointerEvent("pointermove", 0, 120));
    document.dispatchEvent(pointerEvent("pointerup", 0, 120));

    expect(onReorderChild).toHaveBeenCalledWith("root", "dragged-node", "target-node", "after");
  });
});
