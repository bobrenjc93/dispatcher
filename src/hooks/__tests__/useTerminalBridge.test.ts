import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  createTerminalMock,
  writeTerminalMock,
  resizeTerminalMock,
  warmPoolMock,
  appendDebugLogMock,
  createdTerminals,
  createdFitAddons,
  createdChannels,
} = vi.hoisted(() => ({
  createTerminalMock: vi.fn(async () => {}),
  writeTerminalMock: vi.fn(async () => {}),
  resizeTerminalMock: vi.fn(async () => {}),
  warmPoolMock: vi.fn(async () => {}),
  appendDebugLogMock: vi.fn(async () => {}),
  createdTerminals: [] as Array<{
    scrollToBottom: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    resize: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
    cols: number;
    rows: number;
  }>,
  createdFitAddons: [] as Array<{
    fit: ReturnType<typeof vi.fn>;
  }>,
  createdChannels: [] as Array<{
    onmessage: ((message: { terminal_id: string; data: string }) => void) | null;
  }>,
}));

vi.mock("@xterm/xterm", () => {
  class TerminalMock {
    cols = 80;
    rows = 24;
    options: Record<string, unknown>;
    buffer = {
      active: {
        viewportY: 0,
        getLine: vi.fn(() => null),
      },
    };

    open = vi.fn();
    loadAddon = vi.fn();
    registerLinkProvider = vi.fn(() => ({ dispose: vi.fn() }));
    attachCustomKeyEventHandler = vi.fn();
    scrollToBottom = vi.fn();
    write = vi.fn((_data: string, callback?: () => void) => {
      callback?.();
    });
    focus = vi.fn();
    clear = vi.fn();
    paste = vi.fn();
    resize = vi.fn((cols: number, rows: number) => {
      this.cols = cols;
      this.rows = rows;
    });
    refresh = vi.fn();
    dispose = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    onResize = vi.fn(() => ({ dispose: vi.fn() }));

    constructor(options: Record<string, unknown>) {
      this.options = options;
      createdTerminals.push(this);
    }
  }

  return {
    Terminal: TerminalMock,
  };
});

vi.mock("@xterm/addon-fit", () => {
  class FitAddonMock {
    fit = vi.fn();

    constructor() {
      createdFitAddons.push(this);
    }
  }

  return {
    FitAddon: FitAddonMock,
  };
});

vi.mock("@xterm/addon-search", () => {
  class SearchAddonMock {
    clearDecorations = vi.fn();
    findNext = vi.fn();
    findPrevious = vi.fn();
  }

  return {
    SearchAddon: SearchAddonMock,
  };
});

vi.mock("@xterm/addon-webgl", () => {
  class WebglAddonMock {
    onContextLoss = vi.fn();
    dispose = vi.fn();
  }

  return {
    WebglAddon: WebglAddonMock,
  };
});

vi.mock("@tauri-apps/api/core", () => {
  class ChannelMock<T> {
    onmessage: ((message: T) => void) | null = null;

    constructor() {
      createdChannels.push(this as unknown as {
        onmessage: ((message: { terminal_id: string; data: string }) => void) | null;
      });
    }
  }

  return {
    invoke: vi.fn(async () => {}),
    Channel: ChannelMock,
  };
});

vi.mock("../../lib/tauriCommands", () => ({
  createTerminal: createTerminalMock,
  writeTerminal: writeTerminalMock,
  resizeTerminal: resizeTerminalMock,
  warmPool: warmPoolMock,
  appendDebugLog: appendDebugLogMock,
}));

vi.mock("../../components/common/FontSettings", () => ({
  buildFontFamilyCSS: vi.fn(() => "Menlo"),
}));

import {
  captureTerminalScreenshot,
  disposeTerminalInstance,
  ensureTerminalScreenshotTarget,
  handleTerminalInputData,
  hasTerminalFrontend,
  queueTerminalOutput,
  reflectImmediateTabActivity,
  sendSyntheticTerminalInput,
  stripGeneratedTerminalResponseSequences,
  syncTerminalFrontendSize,
} from "../useTerminalBridge";
import { useLayoutStore } from "../../stores/useLayoutStore";
import { useTerminalStore } from "../../stores/useTerminalStore";
import {
  clearStatusResizeSuppressionsForTests,
  markStatusResizeSuppression,
} from "../../lib/statusResizeSuppression";

describe("useTerminalBridge synthetic input", () => {
  beforeEach(() => {
    createdTerminals.length = 0;
    createdFitAddons.length = 0;
    createdChannels.length = 0;
    createTerminalMock.mockClear();
    writeTerminalMock.mockClear();
    resizeTerminalMock.mockClear();
    warmPoolMock.mockClear();
    appendDebugLogMock.mockClear();
    document.body.innerHTML = "";
    useLayoutStore.setState({ layouts: {} });
    useTerminalStore.setState({ sessions: {}, activeTerminalId: null });
    clearStatusResizeSuppressionsForTests();
    globalThis.__dispatcherTmuxTransportOutputRouter = undefined;
  });

  afterEach(() => {
    disposeTerminalInstance("term-scroll-test");
    disposeTerminalInstance("term-canvas-screenshot");
    disposeTerminalInstance("term-large-canvas-screenshot");
    disposeTerminalInstance("tmux-pane-test");
    disposeTerminalInstance("tmux-pane-no-frontend");
    disposeTerminalInstance("term-query-test");
    disposeTerminalInstance("term-local-response-test");
    disposeTerminalInstance("tmux-response-test");
    globalThis.__dispatcherTmuxTransportOutputRouter = undefined;
    disposeTerminalInstance("tab-root");
    disposeTerminalInstance("pane");
    clearStatusResizeSuppressionsForTests();
  });

  it("scrolls synthetic terminal input to the bottom before writing to the PTY", () => {
    expect(hasTerminalFrontend("term-scroll-test")).toBe(false);

    ensureTerminalScreenshotTarget("term-scroll-test");

    expect(hasTerminalFrontend("term-scroll-test")).toBe(true);
    expect(createdTerminals).toHaveLength(1);

    sendSyntheticTerminalInput("term-scroll-test", "\u0003");

    expect(createdTerminals[0].scrollToBottom).toHaveBeenCalledTimes(1);
    expect(writeTerminalMock).toHaveBeenCalledWith("term-scroll-test", "\u0003");
  });

  it("routes existing PTY channel output through the current tmux router", async () => {
    ensureTerminalScreenshotTarget("term-query-test");
    expect(createdChannels).toHaveLength(1);

    const router = vi.fn(() => "routed passthrough");
    globalThis.__dispatcherTmuxTransportOutputRouter = router;
    createdChannels[0].onmessage?.({
      terminal_id: "term-query-test",
      data: "raw transport output",
    });
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(router).toHaveBeenCalledWith("term-query-test", "raw transport output");
    expect(createdTerminals[0].write).toHaveBeenCalledWith(
      "routed passthrough",
      expect.any(Function)
    );
  });

  it("resizes an existing xterm frontend to match a tmux pane grid", () => {
    ensureTerminalScreenshotTarget("term-scroll-test");

    syncTerminalFrontendSize("term-scroll-test", 109, 25);

    expect(createdTerminals[0].resize).toHaveBeenCalledWith(109, 25);
    expect(createdTerminals[0].cols).toBe(109);
    expect(createdTerminals[0].rows).toBe(25);
  });

  it("captures attached xterm canvas layers before falling back to synthetic text rendering", () => {
    const context = {
      drawImage: vi.fn(),
      fillRect: vi.fn(),
      fillText: vi.fn(),
      scale: vi.fn(),
      globalAlpha: 1,
      imageSmoothingEnabled: true,
      fillStyle: "",
      font: "",
      textBaseline: "",
    };
    const getContextSpy = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockImplementation(() => context as unknown as CanvasRenderingContext2D);
    const toDataURLSpy = vi
      .spyOn(HTMLCanvasElement.prototype, "toDataURL")
      .mockImplementation(function toDataURL(this: HTMLCanvasElement) {
        return `data:image/png;base64,${this.width}x${this.height}`;
      });

    try {
      ensureTerminalScreenshotTarget("term-canvas-screenshot");
      const parkingRoot = document.getElementById("dispatcher-terminal-parking-root");
      const element = parkingRoot?.firstElementChild as HTMLDivElement | null;
      expect(element).not.toBeNull();

      element!.style.width = "100px";
      element!.style.height = "50px";
      document.body.appendChild(element!);

      const layer = document.createElement("canvas");
      layer.width = 200;
      layer.height = 100;
      layer.style.width = "100px";
      layer.style.height = "50px";
      element!.appendChild(layer);

      expect(captureTerminalScreenshot("term-canvas-screenshot")).toBe("data:image/png;base64,100x50");
      expect(context.drawImage).toHaveBeenCalledWith(
        layer,
        0,
        0,
        200,
        100,
        0,
        0,
        100,
        50
      );
      expect(context.fillText).not.toHaveBeenCalled();
    } finally {
      getContextSpy.mockRestore();
      toDataURLSpy.mockRestore();
    }
  });

  it("caps debug canvas screenshot resolution before encoding", () => {
    const originalDevicePixelRatio = window.devicePixelRatio;
    Object.defineProperty(window, "devicePixelRatio", {
      configurable: true,
      value: 2,
    });

    const context = {
      drawImage: vi.fn(),
      fillRect: vi.fn(),
      fillText: vi.fn(),
      scale: vi.fn(),
      globalAlpha: 1,
      imageSmoothingEnabled: true,
      fillStyle: "",
      font: "",
      textBaseline: "",
    };
    const getContextSpy = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockImplementation(() => context as unknown as CanvasRenderingContext2D);
    const toDataURLSpy = vi
      .spyOn(HTMLCanvasElement.prototype, "toDataURL")
      .mockImplementation(function toDataURL(this: HTMLCanvasElement) {
        return `data:image/png;base64,${this.width}x${this.height}`;
      });

    try {
      ensureTerminalScreenshotTarget("term-large-canvas-screenshot");
      const parkingRoot = document.getElementById("dispatcher-terminal-parking-root");
      const element = parkingRoot?.firstElementChild as HTMLDivElement | null;
      expect(element).not.toBeNull();

      element!.style.width = "2000px";
      element!.style.height = "1000px";
      document.body.appendChild(element!);

      const layer = document.createElement("canvas");
      layer.width = 4000;
      layer.height = 2000;
      layer.style.width = "2000px";
      layer.style.height = "1000px";
      element!.appendChild(layer);

      expect(captureTerminalScreenshot("term-large-canvas-screenshot")).toBe(
        "data:image/png;base64,1732x866"
      );
      expect(context.fillText).not.toHaveBeenCalled();
    } finally {
      getContextSpy.mockRestore();
      toDataURLSpy.mockRestore();
      Object.defineProperty(window, "devicePixelRatio", {
        configurable: true,
        value: originalDevicePixelRatio,
      });
    }
  });

  it("does not fit tmux pane frontends against the DOM viewport on creation", () => {
    useTerminalStore.getState().addSession("tmux-pane-test", "A");
    useTerminalStore.getState().patchSession("tmux-pane-test", {
      backendKind: "tmux-pane",
      tmuxControlSessionId: "session-1",
      tmuxWindowId: "@1",
      tmuxPaneId: "%1",
    });

    ensureTerminalScreenshotTarget("tmux-pane-test");

    expect(createdFitAddons).toHaveLength(1);
    expect(createdFitAddons[0].fit).not.toHaveBeenCalled();

    disposeTerminalInstance("tmux-pane-test");
  });

  it("does not render output into parked tmux panes", async () => {
    useTerminalStore.getState().addSession("tmux-pane-test", "A");
    useTerminalStore.getState().patchSession("tmux-pane-test", {
      backendKind: "tmux-pane",
      tmuxControlSessionId: "session-1",
      tmuxWindowId: "@1",
      tmuxPaneId: "%1",
    });

    ensureTerminalScreenshotTarget("tmux-pane-test");
    queueTerminalOutput("tmux-pane-test", "real progress\n");
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(createdTerminals[0].write).not.toHaveBeenCalled();
    expect(useTerminalStore.getState().sessions["tmux-pane-test"].lastOutputAt).toBeGreaterThan(0);

    disposeTerminalInstance("tmux-pane-test");
  });

  it("drops parked tmux pane output before scheduling a frame", () => {
    useTerminalStore.getState().addSession("tmux-pane-test", "A");
    useTerminalStore.getState().patchSession("tmux-pane-test", {
      backendKind: "tmux-pane",
      tmuxControlSessionId: "session-1",
      tmuxWindowId: "@1",
      tmuxPaneId: "%1",
    });

    ensureTerminalScreenshotTarget("tmux-pane-test");
    const requestAnimationFrameSpy = vi
      .spyOn(globalThis, "requestAnimationFrame")
      .mockImplementation((_callback: FrameRequestCallback) => 1);

    try {
      queueTerminalOutput("tmux-pane-test", "real progress\n");
      queueTerminalOutput("tmux-pane-test", "more progress\n");

      expect(requestAnimationFrameSpy).not.toHaveBeenCalled();
      expect(createdTerminals[0].write).not.toHaveBeenCalled();
      expect(useTerminalStore.getState().sessions["tmux-pane-test"].lastOutputAt).toBeGreaterThan(0);
    } finally {
      requestAnimationFrameSpy.mockRestore();
      disposeTerminalInstance("tmux-pane-test");
    }
  });

  it("drops tmux pane output without a frontend before scheduling a frame", () => {
    useTerminalStore.getState().addSession("tmux-pane-no-frontend", "A");
    useTerminalStore.getState().patchSession("tmux-pane-no-frontend", {
      backendKind: "tmux-pane",
      tmuxControlSessionId: "session-1",
      tmuxWindowId: "@1",
      tmuxPaneId: "%1",
    });

    const requestAnimationFrameSpy = vi
      .spyOn(globalThis, "requestAnimationFrame")
      .mockImplementation((_callback: FrameRequestCallback) => 1);

    try {
      queueTerminalOutput("tmux-pane-no-frontend", "real progress\n");

      expect(requestAnimationFrameSpy).not.toHaveBeenCalled();
      expect(useTerminalStore.getState().sessions["tmux-pane-no-frontend"].lastOutputAt).toBeGreaterThan(0);
    } finally {
      requestAnimationFrameSpy.mockRestore();
      disposeTerminalInstance("tmux-pane-no-frontend");
    }
  });

  it("renders explicit history hydration writes into parked tmux panes", async () => {
    useTerminalStore.getState().addSession("tmux-pane-test", "A");
    useTerminalStore.getState().patchSession("tmux-pane-test", {
      backendKind: "tmux-pane",
      tmuxControlSessionId: "session-1",
      tmuxWindowId: "@1",
      tmuxPaneId: "%1",
    });

    ensureTerminalScreenshotTarget("tmux-pane-test");
    queueTerminalOutput("tmux-pane-test", "restored history\n", {
      recordActivity: false,
      allowParkedWrite: true,
    });
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(createdTerminals[0].write).toHaveBeenCalledWith(
      "restored history\n",
      expect.any(Function)
    );
    expect(useTerminalStore.getState().sessions["tmux-pane-test"].lastOutputAt).toBe(0);

    disposeTerminalInstance("tmux-pane-test");
  });

  it("replaces buffered output and clears xterm before authoritative tmux history replay", async () => {
    useTerminalStore.getState().addSession("tmux-pane-test", "A");
    useTerminalStore.getState().patchSession("tmux-pane-test", {
      backendKind: "tmux-pane",
      tmuxControlSessionId: "session-1",
      tmuxWindowId: "@1",
      tmuxPaneId: "%1",
    });

    ensureTerminalScreenshotTarget("tmux-pane-test");
    const parkingRoot = document.getElementById("dispatcher-terminal-parking-root");
    const element = parkingRoot?.firstElementChild as HTMLDivElement | null;
    expect(element).not.toBeNull();
    document.body.appendChild(element!);

    queueTerminalOutput("tmux-pane-test", "stale buffered live output\n");
    queueTerminalOutput("tmux-pane-test", "authoritative capture\n", {
      recordActivity: false,
      allowParkedWrite: true,
      replaceBufferedOutput: true,
      clearScrollbackBeforeWrite: true,
    });
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(createdTerminals[0].clear).toHaveBeenCalledTimes(1);
    expect(createdTerminals[0].write).toHaveBeenCalledTimes(1);
    expect(createdTerminals[0].write).toHaveBeenCalledWith(
      "authoritative capture\n",
      expect.any(Function)
    );
    expect(createdTerminals[0].clear.mock.invocationCallOrder[0]).toBeLessThan(
      createdTerminals[0].write.mock.invocationCallOrder[0]
    );

    disposeTerminalInstance("tmux-pane-test");
  });

  it("does not record control-only output as activity", () => {
    useTerminalStore.getState().addSession("tab-root", "A");
    useTerminalStore.getState().addSession("pane", "A");
    useLayoutStore.getState().initLayout("tab-root", "pane");

    useTerminalStore.getState().setDetectedActivity("tab-root", true);
    useTerminalStore.getState().setPossiblyDone("tab-root", true);
    useTerminalStore.getState().setLongInactive("tab-root", true);
    useTerminalStore.getState().setDetectedActivity("pane", true);
    useTerminalStore.getState().setPossiblyDone("pane", true);
    useTerminalStore.getState().setLongInactive("pane", true);

    queueTerminalOutput(
      "pane",
      "\u001b]0;\u2802 Fix and restore PyTorch PR\u0007\u001b[?25l\u001b[?25h\u001b[6n\r"
    );

    expect(useTerminalStore.getState().sessions["tab-root"].isPossiblyDone).toBe(true);
    expect(useTerminalStore.getState().sessions["tab-root"].isLongInactive).toBe(true);
    expect(useTerminalStore.getState().sessions["pane"].isPossiblyDone).toBe(true);
    expect(useTerminalStore.getState().sessions["pane"].isLongInactive).toBe(true);
    expect(useTerminalStore.getState().sessions["pane"].lastOutputAt).toBe(0);
  });

  it("clears brown tab status immediately for a tab-root session when a child pane gets input", () => {
    useTerminalStore.getState().addSession("tab-root", "A");
    useTerminalStore.getState().addSession("pane", "A");
    useLayoutStore.getState().initLayout("tab-root", "pane");

    useTerminalStore.getState().setDetectedActivity("tab-root", true);
    useTerminalStore.getState().setNeedsAttention("tab-root", true);
    useTerminalStore.getState().setPossiblyDone("tab-root", true);
    useTerminalStore.getState().setLongInactive("tab-root", true);
    useTerminalStore.getState().setDetectedActivity("pane", true);
    useTerminalStore.getState().setNeedsAttention("pane", true);
    useTerminalStore.getState().setPossiblyDone("pane", true);
    useTerminalStore.getState().setLongInactive("pane", true);

    reflectImmediateTabActivity("pane");

    expect(useTerminalStore.getState().sessions["tab-root"].isNeedsAttention).toBe(false);
    expect(useTerminalStore.getState().sessions["tab-root"].isPossiblyDone).toBe(false);
    expect(useTerminalStore.getState().sessions["tab-root"].isLongInactive).toBe(false);
    expect(useTerminalStore.getState().sessions["tab-root"].hasDetectedActivity).toBe(true);
    expect(useTerminalStore.getState().sessions["pane"].isNeedsAttention).toBe(false);
    expect(useTerminalStore.getState().sessions["pane"].isPossiblyDone).toBe(false);
    expect(useTerminalStore.getState().sessions["pane"].isLongInactive).toBe(false);
  });

  it("records real output and clears brown tab status", () => {
    useTerminalStore.getState().addSession("tab-root", "A");
    useTerminalStore.getState().addSession("pane", "A");
    useLayoutStore.getState().initLayout("tab-root", "pane");

    useTerminalStore.getState().setDetectedActivity("tab-root", true);
    useTerminalStore.getState().setNeedsAttention("tab-root", true);
    useTerminalStore.getState().setPossiblyDone("tab-root", true);
    useTerminalStore.getState().setLongInactive("tab-root", true);
    useTerminalStore.getState().setDetectedActivity("pane", true);
    useTerminalStore.getState().setNeedsAttention("pane", true);
    useTerminalStore.getState().setPossiblyDone("pane", true);
    useTerminalStore.getState().setLongInactive("pane", true);

    queueTerminalOutput("pane", "still running\n");

    expect(useTerminalStore.getState().sessions["tab-root"].isNeedsAttention).toBe(true);
    expect(useTerminalStore.getState().sessions["tab-root"].isPossiblyDone).toBe(false);
    expect(useTerminalStore.getState().sessions["tab-root"].isLongInactive).toBe(false);
    expect(useTerminalStore.getState().sessions["tab-root"].hasDetectedActivity).toBe(true);
    expect(useTerminalStore.getState().sessions["pane"].isNeedsAttention).toBe(true);
    expect(useTerminalStore.getState().sessions["pane"].isPossiblyDone).toBe(false);
    expect(useTerminalStore.getState().sessions["pane"].isLongInactive).toBe(false);
    expect(useTerminalStore.getState().sessions["pane"].lastOutputAt).toBeGreaterThan(0);
  });

  it("does not mark resize-suppressed output as tab activity", () => {
    useTerminalStore.getState().addSession("tab-root", "A");
    useTerminalStore.getState().addSession("pane", "A");
    useLayoutStore.getState().initLayout("tab-root", "pane");

    useTerminalStore.getState().setDetectedActivity("tab-root", true);
    useTerminalStore.getState().setPossiblyDone("tab-root", true);
    useTerminalStore.getState().setLongInactive("tab-root", true);
    useTerminalStore.getState().setDetectedActivity("pane", true);
    useTerminalStore.getState().setPossiblyDone("pane", true);
    useTerminalStore.getState().setLongInactive("pane", true);

    markStatusResizeSuppression(["pane"], "test-resize");
    queueTerminalOutput("pane", "resize-triggered redraw\n");

    expect(useTerminalStore.getState().sessions["tab-root"].isPossiblyDone).toBe(true);
    expect(useTerminalStore.getState().sessions["tab-root"].isLongInactive).toBe(true);
    expect(useTerminalStore.getState().sessions["pane"].isPossiblyDone).toBe(true);
    expect(useTerminalStore.getState().sessions["pane"].isLongInactive).toBe(true);
    expect(useTerminalStore.getState().sessions["pane"].lastOutputAt).toBe(0);
  });

  it("keeps suppressing resize output after an earlier resize packet touched the timestamp", () => {
    useTerminalStore.getState().addSession("tab-root", "A");
    useTerminalStore.getState().addSession("pane", "A");
    useLayoutStore.getState().initLayout("tab-root", "pane");

    useTerminalStore.getState().setDetectedActivity("tab-root", true);
    useTerminalStore.getState().setLongInactive("tab-root", true);
    useTerminalStore.getState().setDetectedActivity("pane", true);
    useTerminalStore.getState().setLongInactive("pane", true);

    const resizeStartedAt = Date.now();
    const previousResizeOutputAt = resizeStartedAt + 1;
    markStatusResizeSuppression(["pane"], "test-resize", resizeStartedAt);
    useTerminalStore.getState().patchSession("pane", {
      lastOutputAt: previousResizeOutputAt,
    });

    queueTerminalOutput("pane", "another resize redraw\n");

    expect(useTerminalStore.getState().sessions["tab-root"].isLongInactive).toBe(true);
    expect(useTerminalStore.getState().sessions["pane"].isLongInactive).toBe(true);
    expect(useTerminalStore.getState().sessions["pane"].lastOutputAt).toBe(previousResizeOutputAt);
  });

  it("does not clear brown tab status for tmux focus tracking output", () => {
    useTerminalStore.getState().addSession("tab-root", "A");
    useTerminalStore.getState().addSession("pane", "A");
    useLayoutStore.getState().initLayout("tab-root", "pane");

    useTerminalStore.getState().setDetectedActivity("tab-root", true);
    useTerminalStore.getState().setPossiblyDone("tab-root", true);
    useTerminalStore.getState().setLongInactive("tab-root", true);
    useTerminalStore.getState().setDetectedActivity("pane", true);
    useTerminalStore.getState().setPossiblyDone("pane", true);
    useTerminalStore.getState().setLongInactive("pane", true);

    queueTerminalOutput("pane", "\u001b[I");

    expect(useTerminalStore.getState().sessions["tab-root"].isPossiblyDone).toBe(true);
    expect(useTerminalStore.getState().sessions["tab-root"].isLongInactive).toBe(true);
    expect(useTerminalStore.getState().sessions["pane"].isPossiblyDone).toBe(true);
    expect(useTerminalStore.getState().sessions["pane"].isLongInactive).toBe(true);
    expect(useTerminalStore.getState().sessions["pane"].lastOutputAt).toBe(0);
  });

  it("flushes terminal response queries to xterm immediately", () => {
    ensureTerminalScreenshotTarget("term-query-test");
    expect(createdTerminals).toHaveLength(1);

    queueTerminalOutput("term-query-test", "\u001b]11;?\u001b\\\u001b[6n");

    expect(createdTerminals[0].write).toHaveBeenCalledWith(
      "\u001b]11;?\u001b\\\u001b[6n",
      expect.any(Function)
    );
  });

  it("strips generated terminal responses while preserving real input sequences", () => {
    const generatedResponses =
      "\u001b]11;rgb:0a0a/0a0a/0a0a\u001b\\\u001b[4;1R\u001b[>0;276;0c";

    expect(stripGeneratedTerminalResponseSequences(generatedResponses)).toEqual({
      data: "",
      strippedBytes: generatedResponses.length,
      strippedCount: 3,
    });
    expect(stripGeneratedTerminalResponseSequences(`x${generatedResponses}\r`)).toEqual({
      data: "x\r",
      strippedBytes: generatedResponses.length,
      strippedCount: 3,
    });
    expect(stripGeneratedTerminalResponseSequences("\u001b[D")).toEqual({
      data: "\u001b[D",
      strippedBytes: 0,
      strippedCount: 0,
    });
  });

  it("does not count generated terminal responses from tmux panes as user input", () => {
    useTerminalStore.getState().addSession("tmux-response-test", "A");
    useTerminalStore.getState().patchSession("tmux-response-test", {
      backendKind: "tmux-pane",
      tmuxControlSessionId: "session-1",
      tmuxWindowId: "@1",
      tmuxPaneId: "%1",
    });

    handleTerminalInputData(
      "tmux-response-test",
      "\u001b]11;rgb:0a0a/0a0a/0a0a\u001b\\\u001b[4;1R"
    );

    const session = useTerminalStore.getState().sessions["tmux-response-test"];
    expect(session.hasDetectedActivity).toBe(false);
    expect(session.lastUserInputAt).toBe(0);
    expect(writeTerminalMock).not.toHaveBeenCalled();
  });

  it("keeps local terminal responses on the local PTY path", () => {
    const generatedResponse = "\u001b]11;rgb:0a0a/0a0a/0a0a\u001b\\";
    handleTerminalInputData("term-local-response-test", generatedResponse);

    expect(writeTerminalMock).toHaveBeenCalledWith("term-local-response-test", generatedResponse);
  });
});
