import { afterEach, describe, expect, it } from "vitest";
import {
  PENDING_EDIT_TTL_MS,
  clearPendingEdits,
  hasPendingEdits,
  notePendingEdit,
  overlayPendingEdits,
} from "../pendingEdits";

interface Row {
  title: string;
  muted?: boolean;
}

describe("pending edits", () => {
  afterEach(() => clearPendingEdits());

  it("returns the incoming collection untouched when nothing is pending", () => {
    const incoming: Record<string, Row> = { a: { title: "old" } };
    expect(overlayPendingEdits("session", incoming, 0)).toBe(incoming);
  });

  it("holds an edit over snapshots that predate it", () => {
    notePendingEdit("session", "a", { title: "new" }, 0);
    const incoming: Record<string, Row> = { a: { title: "old" }, b: { title: "b" } };

    const result = overlayPendingEdits("session", incoming, 1_000);

    expect(result.a).toEqual({ title: "new" });
    expect(result.b).toBe(incoming.b);
    expect(incoming.a.title).toBe("old");
    expect(hasPendingEdits()).toBe(true);
  });

  it("lets go once the desktop agrees", () => {
    notePendingEdit("session", "a", { title: "new" }, 0);
    overlayPendingEdits("session", { a: { title: "new" } }, 1_000);

    // A later change on the desktop is no longer argued with.
    const result = overlayPendingEdits("session", { a: { title: "newer" } }, 2_000);
    expect(result.a.title).toBe("newer");
    expect(hasPendingEdits()).toBe(false);
  });

  it("settles field by field", () => {
    notePendingEdit("session", "a", { title: "new", muted: true }, 0);
    const result = overlayPendingEdits("session", { a: { title: "new" } }, 1_000);
    expect(result.a).toEqual({ title: "new", muted: true });

    overlayPendingEdits("session", { a: { title: "new", muted: true } }, 2_000);
    expect(hasPendingEdits()).toBe(false);
  });

  it("treats clearing a field as agreeing with a copy that lacks it", () => {
    notePendingEdit("session", "a", { muted: undefined }, 0);
    const incoming: Record<string, Row> = { a: { title: "a" } };
    expect(overlayPendingEdits("session", incoming, 1_000)).toBe(incoming);
    expect(hasPendingEdits()).toBe(false);
  });

  it("gives up on an edit the desktop never made", () => {
    notePendingEdit("session", "a", { title: "new" }, 0);
    const result = overlayPendingEdits("session", { a: { title: "old" } }, PENDING_EDIT_TTL_MS);
    expect(result.a.title).toBe("old");
    expect(hasPendingEdits()).toBe(false);
  });

  it("forgets edits to something the desktop no longer has", () => {
    notePendingEdit("node", "gone", { name: "new" }, 0);
    expect(overlayPendingEdits("node", {}, 1_000)).toEqual({});
    expect(hasPendingEdits()).toBe(false);
  });

  it("keeps the latest of two quick edits", () => {
    notePendingEdit("session", "a", { title: "first" }, 0);
    notePendingEdit("session", "a", { title: "second" }, 100);
    const result = overlayPendingEdits("session", { a: { title: "first" } }, 1_000);
    expect(result.a.title).toBe("second");
  });
});
