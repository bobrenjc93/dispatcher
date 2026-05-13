import { afterEach, describe, expect, it } from "vitest";
import {
  shouldIgnoreDragStartTarget,
  startDrag,
} from "../dragState";

function finishPointerDrag() {
  document.dispatchEvent(new MouseEvent("pointerup", {
    bubbles: true,
    clientX: 0,
    clientY: 0,
  }));
}

describe("dragState", () => {
  afterEach(() => {
    finishPointerDrag();
    document.body.className = "";
    document.body.removeAttribute("style");
    document.body.innerHTML = "";
  });

  it("suppresses document text selection while a sidebar drag is pending", () => {
    document.body.style.userSelect = "text";
    const element = document.createElement("div");
    document.body.append(element);

    startDrag({ type: "project", projectId: "project" }, 0, 0, element);

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
});
