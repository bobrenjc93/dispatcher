import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activateTabAfterPaint,
  clearPendingTab,
  showPendingTab,
  usePendingTabStore,
} from "../pendingTab";

describe("pendingTab", () => {
  afterEach(() => {
    vi.useRealTimers();
    usePendingTabStore.setState({ terminalId: null });
  });

  it("lights the row before switching, and clears once the switch has run", () => {
    vi.useFakeTimers();
    const activate = vi.fn(() => {
      // The switch runs after the frame that showed the highlight.
      expect(usePendingTabStore.getState().terminalId).toBe("a");
    });

    activateTabAfterPaint("a", activate);

    expect(usePendingTabStore.getState().terminalId).toBe("a");
    expect(activate).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(activate).toHaveBeenCalledTimes(1);
    expect(usePendingTabStore.getState().terminalId).toBeNull();
  });

  it("keeps a scheduled switch's highlight through the release that preceded it", () => {
    vi.useFakeTimers();
    showPendingTab("a");
    activateTabAfterPaint("a", () => {});

    clearPendingTab("a");

    expect(usePendingTabStore.getState().terminalId).toBe("a");
    vi.runAllTimers();
    expect(usePendingTabStore.getState().terminalId).toBeNull();
  });

  it("leaves a later pick's highlight alone when an earlier switch lands", () => {
    vi.useFakeTimers();
    const order: string[] = [];
    activateTabAfterPaint("a", () => order.push("a"));
    activateTabAfterPaint("b", () => {
      order.push("b");
    });

    expect(usePendingTabStore.getState().terminalId).toBe("b");
    vi.runAllTimers();
    expect(order).toEqual(["a", "b"]);
    expect(usePendingTabStore.getState().terminalId).toBeNull();
  });

  it("drops a press's highlight when no click follows", () => {
    showPendingTab("a");
    clearPendingTab("a");
    expect(usePendingTabStore.getState().terminalId).toBeNull();
  });
});
