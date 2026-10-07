import { vi, beforeEach } from "vitest";
import { createJSONStorage } from "zustand/middleware";

// ---------------------------------------------------------------------------
// Mock Tauri APIs — vi.mock calls are hoisted before imports
// ---------------------------------------------------------------------------

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => {}),
  Channel: vi.fn().mockImplementation(() => ({ onmessage: null })),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: vi.fn(() => ({ listen: vi.fn(async () => () => {}) })),
}));

// ---------------------------------------------------------------------------
// Stabilize localStorage for zustand persist in the test runtime
// ---------------------------------------------------------------------------

const storageBacking = new Map<string, string>();

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => storageBacking.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storageBacking.set(key, value);
    },
    removeItem: (key: string) => {
      storageBacking.delete(key);
    },
    clear: () => {
      storageBacking.clear();
    },
    key: (index: number) => [...storageBacking.keys()][index] ?? null,
    get length() {
      return storageBacking.size;
    },
  } satisfies Storage,
});

if ("window" in globalThis) {
  Object.defineProperty(globalThis.window, "localStorage", {
    configurable: true,
    value: globalThis.localStorage,
  });
}

// ---------------------------------------------------------------------------
// Import stores after mocks are hoisted
// ---------------------------------------------------------------------------

import { useProjectStore } from "../stores/useProjectStore";
import { useTerminalStore } from "../stores/useTerminalStore";
import { useLayoutStore } from "../stores/useLayoutStore";
import { useFontStore } from "../stores/useFontStore";
import { resetClosedTabsMemory } from "../lib/closedTabs";

// ---------------------------------------------------------------------------
// Reset stores + localStorage before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  const storage = globalThis.localStorage;
  if (storage && typeof storage.clear === "function") {
    storage.clear();
  }
  resetClosedTabsMemory();

  const persistStorage = createJSONStorage(() => globalThis.localStorage) as any;
  useProjectStore.persist.setOptions({ storage: persistStorage });
  useTerminalStore.persist.setOptions({ storage: persistStorage });
  useLayoutStore.persist.setOptions({ storage: persistStorage });
  useFontStore.persist.setOptions({ storage: persistStorage });

  useProjectStore.setState({
    projects: {},
    nodes: {},
    activeProjectId: null,
    projectOrder: [],
  });
  useTerminalStore.setState({
    sessions: {},
    activeTerminalId: null,
  });
  useLayoutStore.setState({ layouts: {} });
  useFontStore.setState({
    fontFamily: "Menlo",
    fontSize: 13,
    fontWeight: "normal",
    fontWeightBold: "bold",
    lineHeight: 1.0,
    letterSpacing: 0,
  });
});
