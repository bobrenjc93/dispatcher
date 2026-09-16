import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createThrottledStateStorage } from "../throttledStorage";

describe("createThrottledStateStorage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("collapses a burst of writes into one", () => {
    const storage = createThrottledStateStorage(1000);
    const setItem = vi.spyOn(window.localStorage, "setItem");

    // What the output path does: rewrite the whole sessions map per batch.
    for (let i = 0; i < 50; i += 1) {
      storage.setItem("k", `value ${i}`);
    }
    expect(setItem).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem("k")).toBe("value 49");
    setItem.mockRestore();
  });

  it("reads back what was just written, before it reaches disk", () => {
    // persist rehydrates and re-reads through the same storage, so a pending
    // value has to be visible or it reads a state one window out of date.
    const storage = createThrottledStateStorage(1000);
    storage.setItem("k", "fresh");
    expect(storage.getItem("k")).toBe("fresh");
    expect(window.localStorage.getItem("k")).toBeNull();

    vi.advanceTimersByTime(1000);
    expect(window.localStorage.getItem("k")).toBe("fresh");
  });

  it("writes everything out when the page goes away", () => {
    // Throttling turns into data loss if a quit can outrun the timer.
    const storage = createThrottledStateStorage(60_000);
    storage.setItem("a", "1");
    storage.setItem("b", "2");
    expect(window.localStorage.getItem("a")).toBeNull();

    window.dispatchEvent(new Event("pagehide"));

    expect(window.localStorage.getItem("a")).toBe("1");
    expect(window.localStorage.getItem("b")).toBe("2");
  });

  it("keeps writing after a flush", () => {
    const storage = createThrottledStateStorage(1000);
    storage.setItem("k", "first");
    vi.advanceTimersByTime(1000);
    expect(window.localStorage.getItem("k")).toBe("first");

    storage.setItem("k", "second");
    vi.advanceTimersByTime(1000);
    expect(window.localStorage.getItem("k")).toBe("second");
  });

  it("removes immediately and forgets any pending write", () => {
    const storage = createThrottledStateStorage(1000);
    window.localStorage.setItem("k", "old");
    storage.setItem("k", "new");
    storage.removeItem("k");

    vi.advanceTimersByTime(1000);
    expect(window.localStorage.getItem("k")).toBeNull();
    expect(storage.getItem("k")).toBeNull();
  });
});
