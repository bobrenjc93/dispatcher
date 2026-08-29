function getPlatform(platform?: string): string {
  if (platform !== undefined) {
    return platform;
  }
  if (typeof navigator === "undefined") {
    return "";
  }
  return navigator.platform;
}

/**
 * Whether the pointer has no modifier keys behind it.
 *
 * A coarse pointer with no hover is a finger. Requiring Cmd or Ctrl to open a
 * link is fine with a keyboard attached and impossible without one, so on a
 * touchscreen a plain tap has to be enough.
 */
export function isTouchPointer(matches?: boolean): boolean {
  if (matches !== undefined) {
    return matches;
  }
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(hover: none) and (pointer: coarse)").matches;
}

/**
 * Whether this event should open a link. A modifier guards it on a desktop so
 * a click still goes to the terminal; a touchscreen has no modifier to hold.
 */
export function shouldOpenLink(
  event: Pick<MouseEvent, "metaKey" | "ctrlKey">,
  options?: { platform?: string; touchPointer?: boolean }
): boolean {
  return (
    isTouchPointer(options?.touchPointer)
    || isLinkOpenModifierPressed(event, options?.platform)
  );
}

export function isLinkOpenModifierPressed(
  event: Pick<MouseEvent, "metaKey" | "ctrlKey">,
  platform?: string
): boolean {
  const resolvedPlatform = getPlatform(platform);
  return resolvedPlatform.startsWith("Mac") ? event.metaKey : event.ctrlKey;
}

export function shouldSyncTmuxFocusOnMouseDown(
  event: Pick<MouseEvent, "button" | "metaKey" | "ctrlKey">,
  platform?: string,
  options?: { isAlreadyActive?: boolean }
): boolean {
  // Clicking an already-active tmux pane does not need a tmux focus sync. That
  // sync can trigger an authoritative pane capture; if the user was starting a
  // local text selection inside a full-screen app such as vim, a raced/stale
  // capture can repaint the normal buffer over the alternate-screen UI.
  if (options?.isAlreadyActive) {
    return false;
  }

  return event.button === 0 && !isLinkOpenModifierPressed(event, platform);
}
