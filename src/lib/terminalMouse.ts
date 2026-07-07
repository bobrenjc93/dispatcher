function getPlatform(platform?: string): string {
  if (platform !== undefined) {
    return platform;
  }
  if (typeof navigator === "undefined") {
    return "";
  }
  return navigator.platform;
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
