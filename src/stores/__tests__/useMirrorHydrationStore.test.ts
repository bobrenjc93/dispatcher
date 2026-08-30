import { beforeEach, describe, expect, it } from "vitest";
import { useMirrorHydrationStore } from "../useMirrorHydrationStore";

describe("mirror hydration", () => {
  beforeEach(() => {
    useMirrorHydrationStore.setState({ hydratedTerminalIds: new Set<string>() });
  });

  it("records a terminal once its first content arrives", () => {
    useMirrorHydrationStore.getState().markTerminalHydrated("t1");
    expect(useMirrorHydrationStore.getState().hydratedTerminalIds.has("t1")).toBe(true);
  });

  it("keeps the same set when a terminal is already known", () => {
    // Output arrives constantly. A fresh set per frame would re-render every
    // subscriber for a change that did not happen.
    const { markTerminalHydrated } = useMirrorHydrationStore.getState();
    markTerminalHydrated("t1");
    const first = useMirrorHydrationStore.getState().hydratedTerminalIds;
    markTerminalHydrated("t1");
    expect(useMirrorHydrationStore.getState().hydratedTerminalIds).toBe(first);
  });

  it("replaces the set when something actually changes, so subscribers see it", () => {
    const { markTerminalHydrated } = useMirrorHydrationStore.getState();
    markTerminalHydrated("t1");
    const first = useMirrorHydrationStore.getState().hydratedTerminalIds;
    markTerminalHydrated("t2");
    expect(useMirrorHydrationStore.getState().hydratedTerminalIds).not.toBe(first);
  });

  it("forgets a terminal, so a reused tab loads again rather than showing stale content", () => {
    const { markTerminalHydrated, forgetTerminalHydration } = useMirrorHydrationStore.getState();
    markTerminalHydrated("t1");
    forgetTerminalHydration("t1");
    expect(useMirrorHydrationStore.getState().hydratedTerminalIds.has("t1")).toBe(false);
  });
});
