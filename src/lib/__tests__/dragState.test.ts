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
