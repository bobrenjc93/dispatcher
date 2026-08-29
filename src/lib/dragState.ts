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

interface DragRuntimeState {
  callbacks: DragCallbacks | null;
}

declare global {
  // Keep drag callbacks across Vite/Tauri dev hot reloads. The Sidebar effect
  // can stay mounted while this module is replaced, and if callbacks live only
  // in module scope drops become no-ops until the app is fully reloaded.
  // eslint-disable-next-line no-var
  var __dispatcherDragRuntimeState: DragRuntimeState | undefined;
}

function getDragRuntimeState(): DragRuntimeState {
  if (!globalThis.__dispatcherDragRuntimeState) {
    globalThis.__dispatcherDragRuntimeState = { callbacks: null };
  }
  return globalThis.__dispatcherDragRuntimeState;
}

let info: DragInfo | null = null;
let active = false;
let startX = 0;
let startY = 0;
let draggedEl: HTMLElement | null = null;

let pointerTypeStarted: string | undefined;
let longPressTimer: number | null = null;

let lastIndicatorEl: HTMLElement | null = null;
let lastDragOverEl: HTMLElement | null = null;
let previousBodyUserSelect: string | null = null;
let previousBodyWebkitUserSelect: string | null = null;
let suppressingTextSelection = false;

const THRESHOLD = 5;
/**
 * A finger never holds still. A tap that wobbles three pixels across and four
 * down beats a five-pixel budget, and once a drag starts the click that would
 * have selected the tab is deliberately swallowed — so on touch every tap
 * looked like a drag and nothing could be selected.
 */
const TOUCH_THRESHOLD = 16;

/**
 * A finger cannot start a drag by moving, the way a mouse does. The sidebar
 * scrolls, so the browser claims a moving touch as a scroll gesture and fires
 * pointercancel long before any movement threshold is met — the drag was being
 * cancelled before it could ever activate, which is why reordering by touch did
 * nothing. Touch drags therefore start from a press that stays put, which is
 * also what every native list-reorder does.
 */
const TOUCH_LONG_PRESS_MS = 400;
/** Movement before the long press fires means the user is scrolling. */
const TOUCH_LONG_PRESS_SLOP = 10;

export function isTouchLikePointer(pointerType?: string): boolean {
  return pointerType === "touch" || pointerType === "pen";
}

/** How far a pointer may travel before a press becomes a drag. */
export function dragActivationThreshold(pointerType?: string): number {
  return isTouchLikePointer(pointerType) ? TOUCH_THRESHOLD : THRESHOLD;
}

/** Manhattan distance, matching how the threshold is expressed. */
export function exceedsDragThreshold(
  dx: number,
  dy: number,
  pointerType?: string
): boolean {
  return Math.abs(dx) + Math.abs(dy) > dragActivationThreshold(pointerType);
}
const INTERACTIVE_DRAG_START_SELECTOR = "button,input,textarea,select,a,[contenteditable='true'],[contenteditable='']";
const dragRuntime = getDragRuntimeState();

export function registerDragCallbacks(cb: DragCallbacks) {
  dragRuntime.callbacks = cb;
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

function activateDrag() {
  if (active) {
    return;
  }
  clearLongPressTimer();
  active = true;
  draggedEl?.classList.add("is-dragging");
  setTextSelectionSuppressed();
  clearDocumentSelection();
}

function handleDragMove(e: PointerEvent | MouseEvent) {
  if (!info) return;

  if (!active) {
    const pointerType = "pointerType" in e ? e.pointerType : pointerTypeStarted;
    if (isTouchLikePointer(pointerType)) {
      // Waiting on the long press. Movement now is a scroll, not a drag, so
      // get out of the way and let the list scroll.
      if (
        Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY)
        > TOUCH_LONG_PRESS_SLOP
      ) {
        end();
      }
      return;
    }
    if (exceedsDragThreshold(e.clientX - startX, e.clientY - startY, pointerType)) {
      activateDrag();
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

function handlePointerMove(e: PointerEvent) {
  handleDragMove(e);
}

function handleMouseMove(e: MouseEvent) {
  handleDragMove(e);
}

function handleDragEnd(e: PointerEvent | MouseEvent) {
  if (!info || !active) {
    end();
    return;
  }

  const el = document.elementFromPoint(e.clientX, e.clientY);

  const callbacks = dragRuntime.callbacks;
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

function handlePointerUp(e: PointerEvent) {
  handleDragEnd(e);
}

function handleMouseUp(e: MouseEvent) {
  handleDragEnd(e);
}

function handlePointerCancel() {
  if (!active) {
    end();
  }
}

function clearLongPressTimer() {
  if (longPressTimer !== null) {
    window.clearTimeout(longPressTimer);
    longPressTimer = null;
  }
}

/**
 * Once a touch drag is live the page must stop scrolling under it. touch-action
 * is fixed when the gesture begins, so it cannot be used here; preventing the
 * default on a non-passive touchmove is what actually holds the list still, and
 * it only works because the long press means no scroll has started yet.
 */
function handleTouchMove(e: TouchEvent) {
  if (active && e.cancelable) {
    e.preventDefault();
  }
}

function preventClick(e: MouseEvent) {
  e.stopPropagation();
  e.preventDefault();
}

function end() {
  clearIndicators();
  clearLongPressTimer();
  if (active) {
    draggedEl?.classList.remove("is-dragging");
    // Prevent the click event that follows pointerup after a drag
    document.addEventListener("click", preventClick, { capture: true, once: true });
  }
  document.removeEventListener("pointermove", handlePointerMove);
  document.removeEventListener("pointerup", handlePointerUp);
  document.removeEventListener("pointercancel", handlePointerCancel);
  document.removeEventListener("mousemove", handleMouseMove);
  document.removeEventListener("mouseup", handleMouseUp);
  document.removeEventListener("touchmove", handleTouchMove);
  restoreTextSelection();
  info = null;
  active = false;
  draggedEl = null;
  pointerTypeStarted = undefined;
}

export function startDrag(
  dragInfo: DragInfo,
  x: number,
  y: number,
  element: HTMLElement,
  pointerType?: string
) {
  info = dragInfo;
  startX = x;
  startY = y;
  active = false;
  draggedEl = element;
  pointerTypeStarted = pointerType;
  document.addEventListener("pointermove", handlePointerMove);
  document.addEventListener("pointerup", handlePointerUp);
  document.addEventListener("pointercancel", handlePointerCancel);
  document.addEventListener("mousemove", handleMouseMove);
  document.addEventListener("mouseup", handleMouseUp);
  if (isTouchLikePointer(pointerType)) {
    document.addEventListener("touchmove", handleTouchMove, { passive: false });
    clearLongPressTimer();
    longPressTimer = window.setTimeout(() => {
      longPressTimer = null;
      if (info) {
        activateDrag();
      }
    }, TOUCH_LONG_PRESS_MS);
  }
}
