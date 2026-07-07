import { describe, expect, it } from "vitest";

import { isLinkOpenModifierPressed, shouldSyncTmuxFocusOnMouseDown } from "../terminalMouse";

describe("terminalMouse", () => {
  it("uses Cmd as the link-open modifier on macOS", () => {
    expect(isLinkOpenModifierPressed({ metaKey: true, ctrlKey: false }, "MacIntel")).toBe(true);
    expect(isLinkOpenModifierPressed({ metaKey: false, ctrlKey: true }, "MacIntel")).toBe(false);
  });

  it("uses Ctrl as the link-open modifier on non-macOS platforms", () => {
    expect(isLinkOpenModifierPressed({ metaKey: false, ctrlKey: true }, "Linux x86_64")).toBe(true);
    expect(isLinkOpenModifierPressed({ metaKey: true, ctrlKey: false }, "Linux x86_64")).toBe(false);
  });

  it("skips tmux focus sync for modifier-open clicks", () => {
    expect(shouldSyncTmuxFocusOnMouseDown({ button: 0, metaKey: true, ctrlKey: false }, "MacIntel")).toBe(false);
    expect(shouldSyncTmuxFocusOnMouseDown({ button: 0, metaKey: false, ctrlKey: true }, "Linux x86_64")).toBe(false);
  });

  it("still syncs tmux focus for plain primary clicks", () => {
    expect(shouldSyncTmuxFocusOnMouseDown({ button: 0, metaKey: false, ctrlKey: false }, "MacIntel")).toBe(true);
  });

  it("skips tmux focus sync for clicks inside the already-active pane", () => {
    expect(shouldSyncTmuxFocusOnMouseDown(
      { button: 0, metaKey: false, ctrlKey: false },
      "MacIntel",
      { isAlreadyActive: true }
    )).toBe(false);
  });

  it("does not sync tmux focus for non-primary clicks", () => {
    expect(shouldSyncTmuxFocusOnMouseDown({ button: 2, metaKey: false, ctrlKey: false }, "MacIntel")).toBe(false);
  });
});
