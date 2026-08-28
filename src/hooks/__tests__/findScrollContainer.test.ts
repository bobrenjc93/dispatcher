import { describe, expect, it } from "vitest";
import { findScrollContainer } from "../../hooks/useTerminalBridge";

function box(overflowY: string, scrollHeight: number, clientHeight: number): HTMLElement {
  const el = document.createElement("div");
  el.style.overflowY = overflowY;
  Object.defineProperty(el, "scrollHeight", { value: scrollHeight, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: clientHeight, configurable: true });
  return el;
}

describe("findScrollContainer", () => {
  it("finds the ancestor that actually scrolls", () => {
    // On a phone the grid is taller than the screen and .terminal-container is
    // the box that scrolls, not xterm's own scrollback.
    const scroller = box("auto", 2000, 400);
    const inner = box("visible", 2000, 2000);
    scroller.appendChild(inner);
    document.body.appendChild(scroller);

    expect(findScrollContainer(inner)).toBe(scroller);
  });

  it("ignores a scrollable box that has nothing to scroll", () => {
    const fits = box("auto", 400, 400);
    const inner = box("visible", 400, 400);
    fits.appendChild(inner);
    document.body.appendChild(fits);

    expect(findScrollContainer(inner)).toBeNull();
  });

  it("returns null when nothing above it scrolls", () => {
    const inner = box("visible", 100, 100);
    document.body.appendChild(inner);
    expect(findScrollContainer(inner)).toBeNull();
  });
});
