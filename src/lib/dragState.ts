type DragInfo =
  | { type: "project"; projectId: string }
  | { type: "terminal"; terminalId: string; projectId: string; nodeId: string };

interface DragCallbacks {
  onReorderProject: (draggedId: string, targetId: string, position: "before" | "after") => void;
  onMoveTerminal: (
    terminalId: string,
    sourceProjectId: string,
    targetProjectId: string,
    targetParentNodeId?: string,
    targetNodeId?: string,
    position?: "before" | "after"
  ) => void;
  onReorderChild: (parentNodeId: string, childId: string, targetChildId: string, position: "before" | "after") => void;
}

let info: DragInfo | null = null;
let active = false;
let startX = 0;
let startY = 0;
let draggedEl: HTMLElement | null = null;
let callbacks: DragCallbacks | null = null;

let lastIndicatorEl: HTMLElement | null = null;
let lastDragOverEl: HTMLElement | null = null;
let previousBodyUserSelect: string | null = null;
let previousBodyWebkitUserSelect: string | null = null;
let suppressingTextSelection = false;

const THRESHOLD = 5;
const INTERACTIVE_DRAG_START_SELECTOR = "button,input,textarea,select,a,[contenteditable='true'],[contenteditable='']";

export function registerDragCallbacks(cb: DragCallbacks) {
  callbacks = cb;
}

export function getDragInfo(): DragInfo | null {
  return info;
}

export function shouldIgnoreDragStartTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(INTERACTIVE_DRAG_START_SELECTOR) !== null;
}

function preventDocumentSelection(e: Event) {
  if (!info) {
    return;
  }
  e.preventDefault();
}

function clearDocumentSelection() {
  window.getSelection()?.removeAllRanges();
}

function setTextSelectionSuppressed() {
  if (suppressingTextSelection) {
    return;
  }

  const bodyStyle = document.body.style as CSSStyleDeclaration & {
    webkitUserSelect?: string;
  };
  previousBodyUserSelect = bodyStyle.userSelect;
  previousBodyWebkitUserSelect = bodyStyle.webkitUserSelect ?? "";
  bodyStyle.userSelect = "none";
  bodyStyle.webkitUserSelect = "none";
  document.body.classList.add("sidebar-dragging");
  document.addEventListener("selectstart", preventDocumentSelection, true);
  suppressingTextSelection = true;
  clearDocumentSelection();
}

function restoreTextSelection() {
  if (!suppressingTextSelection) {
    return;
  }

  const bodyStyle = document.body.style as CSSStyleDeclaration & {
    webkitUserSelect?: string;
  };
  bodyStyle.userSelect = previousBodyUserSelect ?? "";
  bodyStyle.webkitUserSelect = previousBodyWebkitUserSelect ?? "";
  previousBodyUserSelect = null;
  previousBodyWebkitUserSelect = null;
  document.body.classList.remove("sidebar-dragging");
  document.removeEventListener("selectstart", preventDocumentSelection, true);
  suppressingTextSelection = false;
}

function clearIndicators() {
  if (lastIndicatorEl) {
    lastIndicatorEl.classList.remove("drop-indicator-above", "drop-indicator-below");
    lastIndicatorEl = null;
  }
  if (lastDragOverEl) {
    lastDragOverEl.classList.remove("drag-over");
    lastDragOverEl = null;
  }
}

function getMidY(el: HTMLElement): number {
  const rect = el.getBoundingClientRect();
  return rect.top + rect.height / 2;
}

function handlePointerMove(e: PointerEvent) {
  if (!info) return;

  if (!active) {
    if (Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY) > THRESHOLD) {
      active = true;
      draggedEl?.classList.add("is-dragging");
      clearDocumentSelection();
    } else {
      return;
    }
  }

  e.preventDefault();
  clearIndicators();

  const el = document.elementFromPoint(e.clientX, e.clientY);
  if (!el) return;

  if (info.type === "project") {
    const projectNode = el.closest<HTMLElement>("[data-project-id]");
    if (projectNode && projectNode.dataset.projectId !== info.projectId) {
      // Use the header for midpoint calculation (wrapper includes children)
      const header = projectNode.querySelector<HTMLElement>(".sidebar-project-header");
      if (header) {
        const cls = e.clientY < getMidY(header) ? "drop-indicator-above" : "drop-indicator-below";
        projectNode.classList.add(cls);
        lastIndicatorEl = projectNode;
      }
    }
  } else if (info.type === "terminal") {
    const terminalNode = el.closest<HTMLElement>("[data-node-id]");
    if (terminalNode && terminalNode.dataset.nodeId !== info.nodeId) {
      const cls = e.clientY < getMidY(terminalNode) ? "drop-indicator-above" : "drop-indicator-below";
      terminalNode.classList.add(cls);
      lastIndicatorEl = terminalNode;
    } else if (!terminalNode) {
      const childContainer = el.closest<HTMLElement>("[data-terminal-list-parent-node-id]");
      if (childContainer && childContainer.dataset.projectId !== info.projectId) {
        childContainer.classList.add("drop-indicator-below");
        lastIndicatorEl = childContainer;
        return;
      }

      const projectNode = el.closest<HTMLElement>("[data-project-id]");
      if (projectNode && projectNode.dataset.projectId !== info.projectId) {
        projectNode.classList.add("drag-over");
        lastDragOverEl = projectNode;
      }
    }
  }
}

function handlePointerUp(e: PointerEvent) {
  if (!info || !active) {
    end();
    return;
  }

  const el = document.elementFromPoint(e.clientX, e.clientY);

  if (el && callbacks) {
    if (info.type === "project") {
      const projectNode = el.closest<HTMLElement>("[data-project-id]");
      if (projectNode && projectNode.dataset.projectId !== info.projectId) {
        const header = projectNode.querySelector<HTMLElement>(".sidebar-project-header");
        if (header) {
          const position = e.clientY < getMidY(header) ? "before" : "after";
          callbacks.onReorderProject(info.projectId, projectNode.dataset.projectId!, position);
        }
      }
    } else if (info.type === "terminal") {
      const terminalNode = el.closest<HTMLElement>("[data-node-id]");
      if (terminalNode && terminalNode.dataset.nodeId !== info.nodeId) {
        const targetProjectId = terminalNode.dataset.projectId;
        const parentNodeId = terminalNode.dataset.parentNodeId;
        if (targetProjectId && parentNodeId) {
          const position = e.clientY < getMidY(terminalNode) ? "before" : "after";
          if (targetProjectId === info.projectId) {
            callbacks.onReorderChild(parentNodeId, info.nodeId, terminalNode.dataset.nodeId!, position);
          } else {
            callbacks.onMoveTerminal(
              info.terminalId,
              info.projectId,
              targetProjectId,
              parentNodeId,
              terminalNode.dataset.nodeId!,
              position
            );
          }
        }
      } else if (!terminalNode) {
        const childContainer = el.closest<HTMLElement>("[data-terminal-list-parent-node-id]");
        if (childContainer && childContainer.dataset.projectId !== info.projectId) {
          callbacks.onMoveTerminal(
            info.terminalId,
            info.projectId,
            childContainer.dataset.projectId!,
            childContainer.dataset.terminalListParentNodeId
          );
        } else {
          const projectNode = el.closest<HTMLElement>("[data-project-id]");
          if (projectNode && projectNode.dataset.projectId !== info.projectId) {
            callbacks.onMoveTerminal(info.terminalId, info.projectId, projectNode.dataset.projectId!);
          }
        }
      }
    }
  }

  end();
}

function handlePointerCancel() {
  end();
}

function preventClick(e: MouseEvent) {
  e.stopPropagation();
  e.preventDefault();
}

function end() {
  clearIndicators();
  if (active) {
    draggedEl?.classList.remove("is-dragging");
    // Prevent the click event that follows pointerup after a drag
    document.addEventListener("click", preventClick, { capture: true, once: true });
  }
  document.removeEventListener("pointermove", handlePointerMove);
  document.removeEventListener("pointerup", handlePointerUp);
  document.removeEventListener("pointercancel", handlePointerCancel);
  restoreTextSelection();
  info = null;
  active = false;
  draggedEl = null;
}

export function startDrag(dragInfo: DragInfo, x: number, y: number, element: HTMLElement) {
  info = dragInfo;
  startX = x;
  startY = y;
  active = false;
  draggedEl = element;
  setTextSelectionSuppressed();
  document.addEventListener("pointermove", handlePointerMove);
  document.addEventListener("pointerup", handlePointerUp);
  document.addEventListener("pointercancel", handlePointerCancel);
}
