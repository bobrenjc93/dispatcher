import { describe, expect, it } from "vitest";

import { isLinkOpenModifierPressed, shouldSyncTmuxFocusOnMouseDown, shouldOpenLink } from "../terminalMouse";

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

describe("shouldOpenLink", () => {
  it("needs a modifier when there is a keyboard", () => {
    const plain = { metaKey: false, ctrlKey: false };
    expect(shouldOpenLink(plain, { platform: "MacIntel", touchPointer: false })).toBe(false);
    expect(
      shouldOpenLink({ metaKey: true, ctrlKey: false }, { platform: "MacIntel", touchPointer: false })
    ).toBe(true);
  });

  it("opens on a plain tap on a touchscreen", () => {
    // A phone has no Cmd or Ctrl to hold, so requiring one made links
    // unopenable there.
    expect(
      shouldOpenLink({ metaKey: false, ctrlKey: false }, { platform: "iPhone", touchPointer: true })
    ).toBe(true);
  });
});
