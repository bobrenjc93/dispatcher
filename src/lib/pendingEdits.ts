/**
 * A replica's own edits, held until the desktop agrees.
 *
 * A phone changes a tab by relaying the change to the desktop and waiting for
 * the desktop's next snapshot to carry it back. That round trip is seconds on
 * a good day, and a rename that sits on the old name for seconds reads as a
 * rename that did not work. So the phone writes the change into its own copy
 * straight away — and then has to protect it, because every snapshot published
 * before the desktop acted still has the old value, and applying one would put
 * the old name straight back.
 *
 * This is the same bargain {@link ./activeTerminalIntent} makes for the active
 * tab, per field: an edit is laid over each incoming snapshot until one arrives
 * that already says the same thing, or until it expires, because a change the
 * desktop never made must not live on the phone forever.
 */

/** Long enough for the desktop to hear, act, and publish; short enough to not strand. */
export const PENDING_EDIT_TTL_MS = 10_000;

export type PendingEditKind = "session" | "node";

interface PendingEdit {
  fields: Record<string, unknown>;
  at: number;
}

const edits: Record<PendingEditKind, Map<string, PendingEdit>> = {
  session: new Map(),
  node: new Map(),
};

/** Remember fields this client just changed on an entity. Later edits win. */
export function notePendingEdit(
  kind: PendingEditKind,
  id: string,
  fields: Record<string, unknown>,
  now: number = Date.now()
) {
  const existing = edits[kind].get(id);
  edits[kind].set(id, {
    fields: { ...existing?.fields, ...fields },
    at: now,
  });
}

export function clearPendingEdits() {
  edits.session.clear();
  edits.node.clear();
}

export function hasPendingEdits(): boolean {
  return edits.session.size > 0 || edits.node.size > 0;
}

/**
 * Lay this client's unacknowledged edits over an incoming collection.
 *
 * Fields the incoming copy already agrees on are settled and forgotten; the
 * rest are applied. Returns the collection itself when nothing changes, so a
 * snapshot with nothing pending costs nothing.
 */
export function overlayPendingEdits<T extends object>(
  kind: PendingEditKind,
  collection: Record<string, T>,
  now: number = Date.now(),
  ttlMs: number = PENDING_EDIT_TTL_MS
): Record<string, T> {
  const pending = edits[kind];
  if (pending.size === 0) {
    return collection;
  }

  let result = collection;
  for (const [id, edit] of [...pending]) {
    const entity = collection[id] as Record<string, unknown> | undefined;
    // Gone on the desktop, or never acknowledged in time: the desktop is the
    // authority, so stop arguing with it.
    if (!entity || now - edit.at >= ttlMs) {
      pending.delete(id);
      continue;
    }

    const unsettled: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(edit.fields)) {
      if (!Object.is(entity[field], value)) {
        unsettled[field] = value;
      }
    }
    if (Object.keys(unsettled).length === 0) {
      pending.delete(id);
      continue;
    }

    edit.fields = unsettled;
    if (result === collection) {
      result = { ...collection };
    }
    result[id] = { ...entity, ...unsettled } as T;
  }
  return result;
}
