export function isPlainCtrlLetterShortcut(event: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "key">): boolean {
  return event.ctrlKey && !event.metaKey && !event.altKey && /^[a-z]$/i.test(event.key);
}

export function isEventInsideTerminal(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(".terminal-pane") !== null;
}

export function shouldBypassAppShortcutsForTerminal(event: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "key" | "target">): boolean {
  return isPlainCtrlLetterShortcut(event) && isEventInsideTerminal(event.target);
}

export function getCtrlLetterControlCharacter(
  event: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "code">
): string | null {
  if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
    return null;
  }

  const match = event.code.match(/^Key([A-Z])$/);
  if (!match) {
    return null;
  }

  return String.fromCharCode(match[1].charCodeAt(0) - 64);
}

const MAC_OPTION_META_CODE_MAP: Record<string, string> = {
  Space: " ",
  Tab: "\t",
  Enter: "\r",
  Escape: "\u001b",
  Backspace: "\u007f",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backquote: "`",
};

export function getMacOptionMetaSequence(
  event: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "code">
): string | null {
  if (!event.altKey || event.ctrlKey || event.metaKey) {
    return null;
  }

  const letterMatch = event.code.match(/^Key([A-Z])$/);
  if (letterMatch) {
    return `\u001b${event.shiftKey ? letterMatch[1] : letterMatch[1].toLowerCase()}`;
  }

  const digitMatch = event.code.match(/^Digit([0-9])$/);
  if (digitMatch) {
    return `\u001b${digitMatch[1]}`;
  }

  const base = MAC_OPTION_META_CODE_MAP[event.code];
  if (base === undefined) {
    return null;
  }

  return `\u001b${base}`;
}

type ListenerTarget = EventTarget & Pick<Document, "addEventListener" | "removeEventListener">;

function toListenerTarget(target: EventTarget | null | undefined): ListenerTarget | null {
  if (!target || typeof target !== "object") {
    return null;
  }
  if (!("addEventListener" in target) || typeof target.addEventListener !== "function") {
    return null;
  }
  if (!("removeEventListener" in target) || typeof target.removeEventListener !== "function") {
    return null;
  }
  return target as ListenerTarget;
}

const MAC_CTRL_INPUT_EVENT_TYPES = ["beforeinput", "input", "textInput", "keypress"] as const;

export function suppressMacCtrlChordTextInput(
  eventTarget: EventTarget | null,
  ownerDocument: Document = document
): () => void {
  const targets = [toListenerTarget(eventTarget), toListenerTarget(ownerDocument)].filter(
    (target): target is ListenerTarget => target !== null
  );
  const uniqueTargets = [...new Set(targets)];

  const suppress = (event: Event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  for (const target of uniqueTargets) {
    for (const type of MAC_CTRL_INPUT_EVENT_TYPES) {
      target.addEventListener(type, suppress, true);
    }
  }

  let cleanedUp = false;

  return () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;

    for (const target of uniqueTargets) {
      for (const type of MAC_CTRL_INPUT_EVENT_TYPES) {
        target.removeEventListener(type, suppress, true);
      }
    }
  };
}
