import { vi, beforeEach } from "vitest";

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
// Import stores after mocks are hoisted
// ---------------------------------------------------------------------------

import { useProjectStore } from "../stores/useProjectStore";
import { useTerminalStore } from "../stores/useTerminalStore";
import { useLayoutStore } from "../stores/useLayoutStore";
import { useFontStore } from "../stores/useFontStore";

// ---------------------------------------------------------------------------
// Reset stores + localStorage before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  localStorage.clear();

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
