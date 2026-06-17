import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  focusTerminalInstanceMock,
  getTerminalCellSizeMock,
  getTerminalViewportSizeMock,
  queueTerminalOutputMock,
  syncTerminalFrontendSizeMock,
  writeTerminalMock,
} = vi.hoisted(() => ({
  focusTerminalInstanceMock: vi.fn(),
  getTerminalCellSizeMock: vi.fn(() => ({ width: 8, height: 16 })),
  getTerminalViewportSizeMock: vi.fn(() => ({ width: 640, height: 384 })),
  queueTerminalOutputMock: vi.fn(),
  syncTerminalFrontendSizeMock: vi.fn(),
  writeTerminalMock: vi.fn(async () => {}),
}));

vi.mock("../tauriCommands", () => ({
  appendDebugLog: vi.fn(async () => {}),
  writeTerminal: writeTerminalMock,
}));

vi.mock("../../hooks/useTerminalBridge", () => ({
  disposeTerminalInstance: vi.fn(),
  ensureTerminalFrontend: vi.fn(),
  focusTerminalInstance: focusTerminalInstanceMock,
  getTerminalCellSize: getTerminalCellSizeMock,
  getTerminalViewportSize: getTerminalViewportSizeMock,
  queueTerminalOutput: queueTerminalOutputMock,
  syncTerminalFrontendSize: syncTerminalFrontendSizeMock,
}));

import type { TerminalSession } from "../../types/terminal";
import { useLayoutStore } from "../../stores/useLayoutStore";
import { useProjectStore } from "../../stores/useProjectStore";
import { useTerminalStore } from "../../stores/useTerminalStore";
import { TMUX_CONTROL_END, TMUX_CONTROL_START } from "../tmuxControlProtocol";
import {
  clearStatusResizeSuppressionsForTests,
  getActiveStatusResizeSuppression,
} from "../statusResizeSuppression";
import {
  beginTmuxPaneResizeByTerminal,
  clearTmuxTerminal,
  createTmuxWindowForTerminal,
  handleTmuxTerminalFocus,
  resizeTmuxPaneByTerminal,
  routeTmuxTransportOutput,
  sendInputToTmuxTerminal,
  sendPasteToTmuxTerminal,
  syncTmuxWindowSize,
  syncTmuxWindowSizeFromPaneTerminal,
} from "../tmuxControl";

function makeTerminalSession(
  id: string,
  patch: Partial<TerminalSession> = {}
): TerminalSession {
  return {
    id,
    title: "Shell",
    notes: "",
    cwd: undefined,
    hasDetectedActivity: false,
    lastUserInputAt: 0,
    lastOutputAt: 0,
    isNeedsAttention: false,
    isPossiblyDone: false,
    isLongInactive: false,
    isRecentlyFocused: false,
    backendKind: "local",
    ...patch,
  };
}

function resetTmuxRuntime() {
  const runtime = globalThis.__dispatcherTmuxRuntimeState;
  runtime?.controlSessions.clear();
  runtime?.paneTerminalToSessionId.clear();
  runtime?.windowTerminalToSessionId.clear();
  runtime?.transportTerminalToSessionId.clear();
  runtime?.transportRawCarry.clear();
}

function seedTransportTerminal(transportTerminalId: string) {
  useProjectStore.setState({
    projects: {
      project: {
        id: "project",
        name: "Project",
        cwd: "/tmp",
        rootGroupId: "root",
        expanded: true,
      },
    },
    projectOrder: ["project"],
    activeProjectId: "project",
    nodes: {
      root: {
        id: "root",
        type: "group",
        name: "Project",
        parentId: null,
        children: ["transport-node"],
      },
      "transport-node": {
        id: "transport-node",
        type: "terminal",
        name: "Shell",
        terminalId: transportTerminalId,
        parentId: "root",
      },
    },
  });
  useTerminalStore.setState({
    sessions: {
      [transportTerminalId]: makeTerminalSession(transportTerminalId),
    },
    activeTerminalId: transportTerminalId,
  });
  useLayoutStore.setState({
    layouts: {
      [transportTerminalId]: {
        type: "terminal",
        id: "layout-transport",
        terminalId: transportTerminalId,
      },
    },
  });
}

async function hydrateSingleWindow(
  transportTerminalId: string,
  options?: {
    captureInitialContent?: boolean;
  }
) {
  routeTmuxTransportOutput(transportTerminalId, TMUX_CONTROL_START);
  await vi.runOnlyPendingTimersAsync();
  await vi.runOnlyPendingTimersAsync();

  routeTmuxTransportOutput(
    transportTerminalId,
    [
      "%begin 1 0",
      "@1\thappy\t1\t*",
      "%end 1 0",
      "%begin 2 0",
      "@1\t%1\t0\t0\t80\t24\t1\t/Users/bobren\t4\t7\t0",
      "%end 2 0",
      "",
    ].join("\n")
  );
  await Promise.resolve();
  await Promise.resolve();
  if (options?.captureInitialContent !== false) {
    await vi.runOnlyPendingTimersAsync();
    routeTmuxTransportOutput(
      transportTerminalId,
      [
        "%begin 3 0",
        "initial screen",
        "%end 3 0",
        "",
      ].join("\n")
    );
    await Promise.resolve();
    await Promise.resolve();
  }
}

async function hydrateTwoWindows(transportTerminalId: string) {
  routeTmuxTransportOutput(transportTerminalId, TMUX_CONTROL_START);
  await vi.runOnlyPendingTimersAsync();
  await vi.runOnlyPendingTimersAsync();

  routeTmuxTransportOutput(
    transportTerminalId,
    [
      "%begin 1 0",
      "@1\tone\t1\t*",
      "@2\ttwo\t0\t-",
      "%end 1 0",
      "%begin 2 0",
      "@1\t%1\t0\t0\t80\t24\t1\t/Users/bobren/one\t4\t7\t0",
      "@2\t%2\t0\t0\t80\t24\t1\t/Users/bobren/two\t1\t2\t0",
      "%end 2 0",
      "",
    ].join("\n")
  );
  await Promise.resolve();
  await Promise.resolve();
  await vi.runOnlyPendingTimersAsync();
  routeTmuxTransportOutput(
    transportTerminalId,
    [
      "%begin 3 0",
      "",
      "%end 3 0",
      "",
    ].join("\n")
  );
  await Promise.resolve();
  await Promise.resolve();
  await vi.runOnlyPendingTimersAsync();
  routeTmuxTransportOutput(
    transportTerminalId,
    [
      "%begin 4 0",
      "",
      "%end 4 0",
      "",
    ].join("\n")
  );
  await Promise.resolve();
  await Promise.resolve();
}

async function hydrateSplitWindow(transportTerminalId: string) {
  routeTmuxTransportOutput(transportTerminalId, TMUX_CONTROL_START);
  await vi.runOnlyPendingTimersAsync();
  await vi.runOnlyPendingTimersAsync();

  routeTmuxTransportOutput(
    transportTerminalId,
    [
      "%begin 1 0",
      "@1\thappy\t1\t*",
      "%end 1 0",
      "%begin 2 0",
      "@1\t%1\t0\t0\t40\t24\t1\t/Users/bobren/left\t4\t7\t0\t0",
      "@1\t%2\t40\t0\t40\t24\t0\t/Users/bobren/right\t1\t2\t0\t0",
      "%end 2 0",
      "",
    ].join("\n")
  );
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await vi.runOnlyPendingTimersAsync();
  routeTmuxTransportOutput(
    transportTerminalId,
    [
      "%begin 3 0",
      "left screen",
      "%end 3 0",
      "",
    ].join("\n")
  );
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await vi.runOnlyPendingTimersAsync();
  routeTmuxTransportOutput(
    transportTerminalId,
    [
      "%begin 4 0",
      "right screen",
      "%end 4 0",
      "",
    ].join("\n")
  );
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function hydrateThreeWindows(transportTerminalId: string) {
  routeTmuxTransportOutput(transportTerminalId, TMUX_CONTROL_START);
  await vi.runOnlyPendingTimersAsync();
  await vi.runOnlyPendingTimersAsync();

  routeTmuxTransportOutput(
    transportTerminalId,
    [
      "%begin 1 0",
      "@1\tone\t1\t*",
      "@2\ttwo\t0\t-",
      "@3\tthree\t0\t-",
      "%end 1 0",
      "%begin 2 0",
      "@1\t%1\t0\t0\t80\t24\t1\t/Users/bobren/one\t4\t7\t0",
      "@2\t%2\t0\t0\t80\t24\t1\t/Users/bobren/two\t1\t2\t0",
      "@3\t%3\t0\t0\t80\t24\t1\t/Users/bobren/three\t0\t0\t0",
      "%end 2 0",
      "",
    ].join("\n")
  );
  await Promise.resolve();
  await Promise.resolve();

  for (const commandId of [3, 4, 5]) {
    await vi.runOnlyPendingTimersAsync();
    routeTmuxTransportOutput(
      transportTerminalId,
      [
        `%begin ${commandId} 0`,
        "",
        `%end ${commandId} 0`,
        "",
      ].join("\n")
    );
    await Promise.resolve();
    await Promise.resolve();
  }
}

function getHydratedTmuxIds() {
  const sessions = useTerminalStore.getState().sessions;
  const windowEntry = Object.entries(sessions).find(([, session]) => session.backendKind === "tmux-window");
  const paneEntry = Object.entries(sessions).find(([, session]) => session.backendKind === "tmux-pane");
  expect(windowEntry).toBeDefined();
  expect(paneEntry).toBeDefined();
  return {
    windowTerminalId: windowEntry![0],
    paneTerminalId: paneEntry![0],
  };
}

function getWindowTerminalIdByWindowId(windowId: string): string {
  const entry = Object.entries(useTerminalStore.getState().sessions).find(
    ([, session]) => session.backendKind === "tmux-window" && session.tmuxWindowId === windowId
  );
  expect(entry).toBeDefined();
  return entry![0];
}

function getPaneTerminalIdByPaneId(paneId: string): string {
  const entry = Object.entries(useTerminalStore.getState().sessions).find(
    ([, session]) => session.backendKind === "tmux-pane" && session.tmuxPaneId === paneId
  );
  expect(entry).toBeDefined();
  return entry![0];
}

function getNodeIdForTerminalId(terminalId: string): string {
  const entry = Object.entries(useProjectStore.getState().nodes).find(
    ([, node]) => node.type === "terminal" && node.terminalId === terminalId
  );
  expect(entry).toBeDefined();
  return entry![0];
}

function completeTmuxCommand(transportTerminalId: string, commandId: number) {
  routeTmuxTransportOutput(
    transportTerminalId,
    [
      `%begin ${commandId} 0`,
      `%end ${commandId} 0`,
      "",
    ].join("\n")
  );
}

function completeTmuxCommandWithLines(
  transportTerminalId: string,
  commandId: number,
  lines: readonly string[]
) {
  routeTmuxTransportOutput(
    transportTerminalId,
    [
      `%begin ${commandId} 0`,
      ...lines,
      `%end ${commandId} 0`,
      "",
    ].join("\n")
  );
}

function getWrittenTmuxCommand(index: number): string {
  const call = writeTerminalMock.mock.calls[index] as unknown as [string, string] | undefined;
  expect(call).toBeDefined();
  return call![1];
}

async function settleFrontendLayoutTimers() {
  await Promise.resolve();
  await Promise.resolve();
  await vi.runOnlyPendingTimersAsync();
  await vi.runOnlyPendingTimersAsync();
  await Promise.resolve();
  await Promise.resolve();
}

describe("tmuxControl", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    writeTerminalMock.mockClear();
    focusTerminalInstanceMock.mockClear();
    getTerminalCellSizeMock.mockReset();
    getTerminalCellSizeMock.mockReturnValue({ width: 8, height: 16 });
    getTerminalViewportSizeMock.mockReset();
    getTerminalViewportSizeMock.mockReturnValue({ width: 640, height: 384 });
    queueTerminalOutputMock.mockReset();
    queueTerminalOutputMock.mockReturnValue(true);
    syncTerminalFrontendSizeMock.mockReset();
    clearStatusResizeSuppressionsForTests();
    resetTmuxRuntime();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearStatusResizeSuppressionsForTests();
    resetTmuxRuntime();
  });

  it("pastes tmux pane input through a bracket-aware tmux paste buffer", async () => {
    const transportTerminalId = "transport-paste";
    seedTransportTerminal(transportTerminalId);

    await hydrateSingleWindow(transportTerminalId, { captureInitialContent: false });
    const { paneTerminalId } = getHydratedTmuxIds();
    writeTerminalMock.mockClear();

    const pastePromise = sendPasteToTmuxTerminal(paneTerminalId, "one\r\ntwo");
    await Promise.resolve();

    expect(writeTerminalMock).toHaveBeenCalledTimes(1);
    const setBufferCommand = getWrittenTmuxCommand(0);
    const bufferName = /set-buffer -b (\S+) /.exec(setBufferCommand)?.[1];
    expect(bufferName).toMatch(/^dispatcher-paste-/);
    expect(setBufferCommand).toContain('"one\\ntwo"');

    completeTmuxCommand(transportTerminalId, 10);
    await Promise.resolve();
    await Promise.resolve();

    expect(writeTerminalMock).toHaveBeenCalledTimes(2);
    expect(getWrittenTmuxCommand(1)).toBe(
      `paste-buffer -p -d -b ${bufferName} -t %1\n`
    );

    completeTmuxCommand(transportTerminalId, 11);
    await expect(pastePromise).resolves.toBe(true);
  });

  it("reports progress while loading tmux paste buffers", async () => {
    const transportTerminalId = "transport-paste-progress";
    seedTransportTerminal(transportTerminalId);

    await hydrateSingleWindow(transportTerminalId, { captureInitialContent: false });
    const { paneTerminalId } = getHydratedTmuxIds();
    writeTerminalMock.mockClear();

    const onProgress = vi.fn();
    const pastePromise = sendPasteToTmuxTerminal(
      paneTerminalId,
      `${"a".repeat(8_000)}${"b".repeat(8_000)}`,
      { onProgress }
    );
    await Promise.resolve();

    expect(onProgress).toHaveBeenLastCalledWith({
      phase: "preparing",
      completedChunks: 0,
      totalChunks: 2,
      totalBytes: 16_000,
    });
    expect(writeTerminalMock).toHaveBeenCalledTimes(1);

    completeTmuxCommand(transportTerminalId, 10);
    await Promise.resolve();
    await Promise.resolve();
    expect(onProgress).toHaveBeenLastCalledWith({
      phase: "buffering",
      completedChunks: 1,
      totalChunks: 2,
      totalBytes: 16_000,
    });
    expect(writeTerminalMock).toHaveBeenCalledTimes(2);

    completeTmuxCommand(transportTerminalId, 11);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(onProgress).toHaveBeenLastCalledWith({
      phase: "pasting",
      completedChunks: 2,
      totalChunks: 2,
      totalBytes: 16_000,
    });
    expect(writeTerminalMock).toHaveBeenCalledTimes(3);

    completeTmuxCommand(transportTerminalId, 12);
    await expect(pastePromise).resolves.toBe(true);
  });

  it("terminates tmux set-buffer options before paste text chunks", async () => {
    const transportTerminalId = "transport-paste-leading-dash-chunk";
    seedTransportTerminal(transportTerminalId);

    await hydrateSingleWindow(transportTerminalId, { captureInitialContent: false });
    const { paneTerminalId } = getHydratedTmuxIds();
    writeTerminalMock.mockClear();

    const pastePromise = sendPasteToTmuxTerminal(
      paneTerminalId,
      `${"a".repeat(8_000)}-05-17T16:07:16.033-07:00`
    );
    await Promise.resolve();

    const firstSetBufferCommand = getWrittenTmuxCommand(0);
    const bufferName = /set-buffer -b (\S+) -- /.exec(firstSetBufferCommand)?.[1];
    expect(bufferName).toMatch(/^dispatcher-paste-/);
    expect(firstSetBufferCommand).toContain(`set-buffer -b ${bufferName} -- "`);

    completeTmuxCommand(transportTerminalId, 10);
    await Promise.resolve();
    await Promise.resolve();

    expect(getWrittenTmuxCommand(1)).toContain(
      `set-buffer -a -b ${bufferName} -- "-05-17T16:07:16.033-07:00"`
    );

    completeTmuxCommand(transportTerminalId, 11);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(getWrittenTmuxCommand(2)).toBe(
      `paste-buffer -p -d -b ${bufferName} -t %1\n`
    );

    completeTmuxCommand(transportTerminalId, 12);
    await expect(pastePromise).resolves.toBe(true);
  });

  it("routes complete bracketed paste input through the tmux paste path", async () => {
    const transportTerminalId = "transport-bracketed-paste";
    seedTransportTerminal(transportTerminalId);

    await hydrateSingleWindow(transportTerminalId, { captureInitialContent: false });
    const { paneTerminalId } = getHydratedTmuxIds();
    writeTerminalMock.mockClear();

    const pastePromise = sendInputToTmuxTerminal(
      paneTerminalId,
      "\u001b[200~alpha\rbravo\u001b[201~"
    );
    await Promise.resolve();

    expect(writeTerminalMock).toHaveBeenCalledTimes(1);
    expect(getWrittenTmuxCommand(0)).toContain("set-buffer -b dispatcher-paste-");
    expect(getWrittenTmuxCommand(0)).toContain('"alpha\\nbravo"');
    expect(getWrittenTmuxCommand(0)).not.toContain("send-keys");

    completeTmuxCommand(transportTerminalId, 20);
    await Promise.resolve();
    await Promise.resolve();
    completeTmuxCommand(transportTerminalId, 21);

    await expect(pastePromise).resolves.toBe(true);
  });

  it("clears tmux pane history for Cmd+K", async () => {
    const transportTerminalId = "transport-clear-history";
    seedTransportTerminal(transportTerminalId);

    await hydrateSingleWindow(transportTerminalId);
    const { paneTerminalId } = getHydratedTmuxIds();
    writeTerminalMock.mockClear();

    const clearPromise = clearTmuxTerminal(paneTerminalId);
    await Promise.resolve();
    expect(writeTerminalMock).toHaveBeenCalledWith(
      transportTerminalId,
      "clear-history -t %1\n"
    );

    completeTmuxCommand(transportTerminalId, 30);
    await Promise.resolve();
    await Promise.resolve();
    expect(writeTerminalMock).toHaveBeenCalledWith(
      transportTerminalId,
      "send-keys -t %1 C-l\n"
    );

    completeTmuxCommand(transportTerminalId, 31);
    await expect(clearPromise).resolves.toBe(true);
    await expect(clearTmuxTerminal("not-tmux")).resolves.toBe(false);
  });

  it("does not let an in-flight tmux history capture repaint Cmd+K-cleared scrollback", async () => {
    const transportTerminalId = "transport-clear-skips-stale-capture";
    seedTransportTerminal(transportTerminalId);

    await hydrateSingleWindow(transportTerminalId);
    const { paneTerminalId } = getHydratedTmuxIds();

    routeTmuxTransportOutput(transportTerminalId, "%layout-change @1\n");
    await vi.runOnlyPendingTimersAsync();
    routeTmuxTransportOutput(
      transportTerminalId,
      [
        "%begin 4 0",
        "@1\thappy\t1\t*",
        "%end 4 0",
        "%begin 5 0",
        "@1\t%1\t0\t0\t80\t24\t1\t/Users/bobren\t4\t7\t0\t88",
        "%end 5 0",
        "",
      ].join("\n")
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    writeTerminalMock.mockClear();
    queueTerminalOutputMock.mockClear();
    handleTmuxTerminalFocus(paneTerminalId);
    expect(writeTerminalMock).toHaveBeenCalledWith(
      transportTerminalId,
      "capture-pane -p -e -C -S -88 -t %1\n"
    );

    const clearPromise = clearTmuxTerminal(paneTerminalId);
    await Promise.resolve();

    routeTmuxTransportOutput(
      transportTerminalId,
      [
        "%begin 6 0",
        "%end 6 0",
        "%begin 7 0",
        "old history that should stay cleared",
        "old current row",
        "%end 7 0",
        "%begin 8 0",
        "%end 8 0",
        "%begin 9 0",
        "%end 9 0",
        "",
      ].join("\n")
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(queueTerminalOutputMock).not.toHaveBeenCalledWith(
      paneTerminalId,
      expect.stringContaining("old history that should stay cleared"),
      expect.anything()
    );

    routeTmuxTransportOutput(
      transportTerminalId,
      [
        "%begin 10 0",
        "%end 10 0",
        "",
      ].join("\n")
    );
    await expect(clearPromise).resolves.toBe(true);
  });

  it("keeps hydrated tmux windows as disconnected placeholders when control mode exits", async () => {
    const transportTerminalId = "transport-detach";
    seedTransportTerminal(transportTerminalId);

    await hydrateSingleWindow(transportTerminalId);
    const { windowTerminalId, paneTerminalId } = getHydratedTmuxIds();
    useTerminalStore.getState().setActiveTerminal(paneTerminalId);

    routeTmuxTransportOutput(transportTerminalId, "%exit\n");

    const terminalState = useTerminalStore.getState();
    const projectState = useProjectStore.getState();
    expect(terminalState.sessions[windowTerminalId]).toMatchObject({
      backendKind: "tmux-window",
      tmuxControlSessionId: undefined,
      tmuxWindowId: "@1",
      tmuxPaneId: undefined,
      title: "happy",
    });
    expect(terminalState.sessions[paneTerminalId]).toMatchObject({
      backendKind: "tmux-pane",
      tmuxControlSessionId: undefined,
      tmuxWindowId: "@1",
      tmuxPaneId: "%1",
      cwd: "/Users/bobren",
    });
    expect(useLayoutStore.getState().layouts[windowTerminalId]).toBeDefined();
    expect(Object.values(projectState.nodes).some((node) => node.terminalId === windowTerminalId)).toBe(true);
    expect(projectState.nodes["transport-node"].hidden).toBe(false);
    expect(terminalState.sessions[transportTerminalId]).toMatchObject({
      backendKind: "local",
      tmuxControlSessionId: undefined,
    });
    expect(terminalState.activeTerminalId).toBe(transportTerminalId);
  });

  it("routes ordinary tmux pane output as activity", async () => {
    const transportTerminalId = "transport-pane-output";
    seedTransportTerminal(transportTerminalId);

    await hydrateSingleWindow(transportTerminalId);
    const { paneTerminalId } = getHydratedTmuxIds();
    queueTerminalOutputMock.mockClear();

    routeTmuxTransportOutput(transportTerminalId, "%output %1 real output\n");

    expect(queueTerminalOutputMock).toHaveBeenCalledWith(
      paneTerminalId,
      "real output"
    );
  });

  it("routes tmux extended-output notifications as pane output", async () => {
    const transportTerminalId = "transport-extended-pane-output";
    seedTransportTerminal(transportTerminalId);

    await hydrateSingleWindow(transportTerminalId);
    const { paneTerminalId } = getHydratedTmuxIds();
    queueTerminalOutputMock.mockClear();

    routeTmuxTransportOutput(transportTerminalId, "%extended-output %1 42 future : extended output\n");

    expect(queueTerminalOutputMock).toHaveBeenCalledWith(
      paneTerminalId,
      "extended output"
    );
  });

  it("syncs alternate screen mode before replaying hidden TUI pane content", async () => {
    const transportTerminalId = "transport-hidden-alternate-screen";
    seedTransportTerminal(transportTerminalId);

    await hydrateSingleWindow(transportTerminalId);
    const paneTerminalId = getPaneTerminalIdByPaneId("%1");
    useTerminalStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        other: makeTerminalSession("other"),
      },
      activeTerminalId: "other",
    }));
    writeTerminalMock.mockClear();
    queueTerminalOutputMock.mockClear();

    routeTmuxTransportOutput(transportTerminalId, "%output %1 \\033[?1049h\\033[HClaude\n");
    queueTerminalOutputMock.mockClear();
    handleTmuxTerminalFocus(paneTerminalId);

    expect(writeTerminalMock).toHaveBeenCalledWith(
      transportTerminalId,
      "capture-pane -p -e -C -a -q -t %1\n"
    );

    routeTmuxTransportOutput(
      transportTerminalId,
      [
        "%begin 4 0",
        "%end 4 0",
        "%begin 5 0",
        "Claude screen",
        "%end 5 0",
        "%begin 6 0",
        "%end 6 0",
        "",
      ].join("\n")
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(writeTerminalMock).toHaveBeenCalledWith(
      transportTerminalId,
      'display-message -p -t %1 "#{cursor_x}\\t#{cursor_y}"\n'
    );

    completeTmuxCommandWithLines(transportTerminalId, 7, ["4\t7"]);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(queueTerminalOutputMock).toHaveBeenCalledWith(
      paneTerminalId,
      "\u001b[?1049h\u001b[0m\u001b[?7l\u001b[H\u001b[2JClaude screen\u001b[?7h\u001b[0m\u001b[8;5H",
      { recordActivity: false, replaceBufferedOutput: true }
    );
  });

  it("does not record tmux focus sync output as pane activity", async () => {
    const transportTerminalId = "transport-focus-output";
    seedTransportTerminal(transportTerminalId);

    await hydrateSingleWindow(transportTerminalId);
    const { paneTerminalId } = getHydratedTmuxIds();
    queueTerminalOutputMock.mockClear();

    handleTmuxTerminalFocus(paneTerminalId);
    routeTmuxTransportOutput(transportTerminalId, "%output %1 focus redraw\n");

    expect(queueTerminalOutputMock).toHaveBeenCalledWith(
      paneTerminalId,
      "focus redraw",
      { recordActivity: false }
    );
  });

  it("does not apply a visible redraw capture after newer pane output arrives", async () => {
    const transportTerminalId = "transport-raced-visible-redraw";
    seedTransportTerminal(transportTerminalId);

    await hydrateSingleWindow(transportTerminalId);
    const { paneTerminalId } = getHydratedTmuxIds();
    writeTerminalMock.mockClear();
    queueTerminalOutputMock.mockClear();

    handleTmuxTerminalFocus(paneTerminalId);
    expect(writeTerminalMock).toHaveBeenCalledWith(
      transportTerminalId,
      "capture-pane -p -e -C -t %1\n"
    );

    routeTmuxTransportOutput(transportTerminalId, "%output %1 live update\n");
    routeTmuxTransportOutput(
      transportTerminalId,
      [
        "%begin 4 0",
        "%end 4 0",
        "%begin 5 0",
        "stale captured screen",
        "%end 5 0",
        "%begin 6 0",
        "%end 6 0",
        "",
      ].join("\n")
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(queueTerminalOutputMock).toHaveBeenCalledWith(
      paneTerminalId,
      "live update",
      { recordActivity: false }
    );
    expect(queueTerminalOutputMock).not.toHaveBeenCalledWith(
      paneTerminalId,
      expect.stringContaining("stale captured screen"),
      expect.anything()
    );
  });

  it("repairs cursor-addressed visible tmux output after it settles", async () => {
    const transportTerminalId = "transport-visible-redraw-repair";
    seedTransportTerminal(transportTerminalId);

    await hydrateSingleWindow(transportTerminalId);
    const { paneTerminalId } = getHydratedTmuxIds();
    useTerminalStore.getState().setActiveTerminal(paneTerminalId);
    writeTerminalMock.mockClear();
    queueTerminalOutputMock.mockClear();

    routeTmuxTransportOutput(transportTerminalId, "%output %1 \\033[31;2H\\033[Klive tui frame\n");

    expect(queueTerminalOutputMock).toHaveBeenCalledWith(
      paneTerminalId,
      "\u001b[31;2H\u001b[Klive tui frame"
    );
    expect(writeTerminalMock).not.toHaveBeenCalledWith(
      transportTerminalId,
      "capture-pane -p -e -C -t %1\n"
    );

    await vi.advanceTimersByTimeAsync(1_200);
    expect(writeTerminalMock).toHaveBeenCalledWith(
      transportTerminalId,
      "capture-pane -p -e -C -t %1\n"
    );

    routeTmuxTransportOutput(
      transportTerminalId,
      [
        "%begin 4 0",
        "authoritative frame",
        "%end 4 0",
        "",
      ].join("\n")
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(writeTerminalMock).toHaveBeenCalledWith(
      transportTerminalId,
      'display-message -p -t %1 "#{cursor_x}\\t#{cursor_y}"\n'
    );

    completeTmuxCommandWithLines(transportTerminalId, 5, ["4\t7"]);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(queueTerminalOutputMock).toHaveBeenCalledWith(
      paneTerminalId,
      "\u001b[0m\u001b[?7l\u001b[H\u001b[2Jauthoritative frame\u001b[?7h\u001b[0m\u001b[8;5H",
      { recordActivity: false, replaceBufferedOutput: true }
    );
  });

  it("does not schedule authoritative redraws for plain tmux output", async () => {
    const transportTerminalId = "transport-visible-redraw-plain-output";
    seedTransportTerminal(transportTerminalId);

    await hydrateSingleWindow(transportTerminalId);
    const { paneTerminalId } = getHydratedTmuxIds();
    useTerminalStore.getState().setActiveTerminal(paneTerminalId);
    writeTerminalMock.mockClear();

    routeTmuxTransportOutput(transportTerminalId, "%output %1 plain output\n");
    await vi.advanceTimersByTimeAsync(500);

    expect(writeTerminalMock).not.toHaveBeenCalledWith(
      transportTerminalId,
      "capture-pane -p -e -C -t %1\n"
    );
  });

  it("retries settled visible redraws when pane output races the capture", async () => {
    const transportTerminalId = "transport-visible-redraw-retry";
    seedTransportTerminal(transportTerminalId);

    await hydrateSingleWindow(transportTerminalId);
    const { paneTerminalId } = getHydratedTmuxIds();
    useTerminalStore.getState().setActiveTerminal(paneTerminalId);
    writeTerminalMock.mockClear();
    queueTerminalOutputMock.mockClear();

    routeTmuxTransportOutput(transportTerminalId, "%output %1 \\033[31;2H\\033[Kfirst tui frame\n");
    await vi.advanceTimersByTimeAsync(1_200);
    expect(writeTerminalMock).toHaveBeenCalledWith(
      transportTerminalId,
      "capture-pane -p -e -C -t %1\n"
    );

    routeTmuxTransportOutput(transportTerminalId, "%output %1 \\033[31;2H\\033[Knewer tui frame\n");
    routeTmuxTransportOutput(
      transportTerminalId,
      [
        "%begin 4 0",
        "stale authoritative frame",
        "%end 4 0",
        "",
      ].join("\n")
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(queueTerminalOutputMock).not.toHaveBeenCalledWith(
      paneTerminalId,
      expect.stringContaining("stale authoritative frame"),
      expect.anything()
    );

    writeTerminalMock.mockClear();
    await vi.advanceTimersByTimeAsync(1_200);
    expect(writeTerminalMock).toHaveBeenCalledWith(
      transportTerminalId,
      "capture-pane -p -e -C -t %1\n"
    );
  });

  it("keeps retrying visible redraws instead of forcing a stale capture after repeated races", async () => {
    const transportTerminalId = "transport-visible-redraw-no-force-after-races";
    seedTransportTerminal(transportTerminalId);

    await hydrateSingleWindow(transportTerminalId);
    const { paneTerminalId } = getHydratedTmuxIds();
    useTerminalStore.getState().setActiveTerminal(paneTerminalId);
    writeTerminalMock.mockClear();
    queueTerminalOutputMock.mockClear();

    routeTmuxTransportOutput(transportTerminalId, "%output %1 \\033[31;2H\\033[Kfirst tui frame\n");
    await vi.advanceTimersByTimeAsync(1_200);
    routeTmuxTransportOutput(transportTerminalId, "%output %1 \\033[31;2H\\033[Ksecond tui frame\n");
    completeTmuxCommandWithLines(transportTerminalId, 4, ["stale authoritative frame 1"]);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(queueTerminalOutputMock).not.toHaveBeenCalledWith(
      paneTerminalId,
      expect.stringContaining("stale authoritative frame 1"),
      expect.anything()
    );

    await vi.advanceTimersByTimeAsync(300);
    routeTmuxTransportOutput(transportTerminalId, "%output %1 \\033[31;2H\\033[Kthird tui frame\n");
    completeTmuxCommandWithLines(transportTerminalId, 5, ["stale authoritative frame 2"]);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(queueTerminalOutputMock).not.toHaveBeenCalledWith(
      paneTerminalId,
      expect.stringContaining("stale authoritative frame 2"),
      expect.anything()
    );

    await vi.advanceTimersByTimeAsync(300);
    routeTmuxTransportOutput(transportTerminalId, "%output %1 \\033[31;2H\\033[Kfourth tui frame\n");
    completeTmuxCommandWithLines(transportTerminalId, 6, ["still stale authoritative frame"]);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(queueTerminalOutputMock).not.toHaveBeenCalledWith(
      paneTerminalId,
      expect.stringContaining("still stale authoritative frame"),
      expect.anything()
    );
  });

  it("keeps retrying visible redraws instead of forcing a stale cursor-raced capture", async () => {
    const transportTerminalId = "transport-visible-redraw-no-force-after-cursor-races";
    seedTransportTerminal(transportTerminalId);

    await hydrateSingleWindow(transportTerminalId);
    const { paneTerminalId } = getHydratedTmuxIds();
    useTerminalStore.getState().setActiveTerminal(paneTerminalId);
    writeTerminalMock.mockClear();
    queueTerminalOutputMock.mockClear();

    routeTmuxTransportOutput(transportTerminalId, "%output %1 \\033[31;2H\\033[Kfirst tui frame\n");
    await vi.advanceTimersByTimeAsync(1_200);
    completeTmuxCommandWithLines(transportTerminalId, 4, ["cursor-raced frame 1"]);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    routeTmuxTransportOutput(transportTerminalId, "%output %1 \\033[31;2H\\033[Ksecond tui frame\n");
    completeTmuxCommandWithLines(transportTerminalId, 5, ["4\t7"]);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(queueTerminalOutputMock).not.toHaveBeenCalledWith(
      paneTerminalId,
      expect.stringContaining("cursor-raced frame 1"),
      expect.anything()
    );

    await vi.advanceTimersByTimeAsync(300);
    completeTmuxCommandWithLines(transportTerminalId, 6, ["cursor-raced frame 2"]);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    routeTmuxTransportOutput(transportTerminalId, "%output %1 \\033[31;2H\\033[Kthird tui frame\n");
    completeTmuxCommandWithLines(transportTerminalId, 7, ["4\t7"]);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(queueTerminalOutputMock).not.toHaveBeenCalledWith(
      paneTerminalId,
      expect.stringContaining("cursor-raced frame 2"),
      expect.anything()
    );

    await vi.advanceTimersByTimeAsync(300);
    completeTmuxCommandWithLines(transportTerminalId, 8, ["still stale cursor-raced frame"]);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    routeTmuxTransportOutput(transportTerminalId, "%output %1 \\033[31;2H\\033[Kfourth tui frame\n");
    completeTmuxCommandWithLines(transportTerminalId, 9, ["4\t7"]);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(queueTerminalOutputMock).not.toHaveBeenCalledWith(
      paneTerminalId,
      expect.stringContaining("still stale cursor-raced frame"),
      expect.anything()
    );
  });

  it("does not replay a visible redraw captured before user input", async () => {
    const transportTerminalId = "transport-visible-redraw-user-input";
    seedTransportTerminal(transportTerminalId);

    await hydrateSingleWindow(transportTerminalId);
    const { paneTerminalId } = getHydratedTmuxIds();
    useTerminalStore.getState().setActiveTerminal(paneTerminalId);
    writeTerminalMock.mockClear();
    queueTerminalOutputMock.mockClear();

    routeTmuxTransportOutput(transportTerminalId, "%output %1 \\033[31;2H\\033[Klive tui frame\n");
    await vi.advanceTimersByTimeAsync(1_200);
    expect(writeTerminalMock).toHaveBeenCalledWith(
      transportTerminalId,
      "capture-pane -p -e -C -t %1\n"
    );

    const inputPromise = sendInputToTmuxTerminal(paneTerminalId, "vim ~/.bash_profile\r");
    completeTmuxCommandWithLines(transportTerminalId, 4, ["shell frame before vim"]);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(queueTerminalOutputMock).not.toHaveBeenCalledWith(
      paneTerminalId,
      expect.stringContaining("shell frame before vim"),
      expect.anything()
    );
    completeTmuxCommandWithLines(transportTerminalId, 5, []);
    await expect(inputPromise).resolves.toBe(true);
  });

  it("does not schedule live visible redraw repairs while an alternate-screen app is active", async () => {
    const transportTerminalId = "transport-visible-redraw-alternate-screen";
    seedTransportTerminal(transportTerminalId);

    await hydrateSingleWindow(transportTerminalId);
    const { paneTerminalId } = getHydratedTmuxIds();
    useTerminalStore.getState().setActiveTerminal(paneTerminalId);
    writeTerminalMock.mockClear();
    queueTerminalOutputMock.mockClear();

    routeTmuxTransportOutput(transportTerminalId, "%output %1 \\033[?1049h\\033[Hvim frame\n");
    await vi.advanceTimersByTimeAsync(500);

    expect(queueTerminalOutputMock).toHaveBeenCalledWith(
      paneTerminalId,
      "\u001b[?1049h\u001b[Hvim frame"
    );
    expect(writeTerminalMock).not.toHaveBeenCalledWith(
      transportTerminalId,
      "capture-pane -p -e -C -a -q -t %1\n"
    );
  });

  it("hydrates tmux control output when the DCS start marker is missing", async () => {
    const transportTerminalId = "transport-bare-control";
    seedTransportTerminal(transportTerminalId);

    const passthrough = routeTmuxTransportOutput(
      transportTerminalId,
      [
        "tmux -CC\r",
        "%begin 9 0",
        "%end 9 0",
        "%window-add @1",
        "%sessions-changed",
        "%session-changed $1 remote",
        "",
      ].join("\n")
    );
    expect(passthrough).toBe("tmux -CC\r\n");

    await vi.runOnlyPendingTimersAsync();
    await vi.runOnlyPendingTimersAsync();
    expect(writeTerminalMock).toHaveBeenCalled();
    routeTmuxTransportOutput(
      transportTerminalId,
      [
        "%begin 10 0",
        "@1\thappy\t1\t*",
        "%end 10 0",
        "%begin 11 0",
        "@1\t%1\t0\t0\t80\t24\t1\t/home/bobren\t2\t3\t0",
        "%end 11 0",
        "",
      ].join("\n")
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const { windowTerminalId, paneTerminalId } = getHydratedTmuxIds();
    expect(useTerminalStore.getState().sessions[windowTerminalId]).toMatchObject({
      backendKind: "tmux-window",
      tmuxControlSessionId: transportTerminalId,
      tmuxWindowId: "@1",
      title: "happy",
    });
    expect(useTerminalStore.getState().sessions[paneTerminalId]).toMatchObject({
      backendKind: "tmux-pane",
      tmuxControlSessionId: transportTerminalId,
      tmuxWindowId: "@1",
      tmuxPaneId: "%1",
      cwd: "/home/bobren",
    });
  });

  it("restores tmux history with autowrap disabled without a second screen redraw", async () => {
    const transportTerminalId = "transport-history-redraw";
    seedTransportTerminal(transportTerminalId);

    routeTmuxTransportOutput(transportTerminalId, TMUX_CONTROL_START);
    await vi.runOnlyPendingTimersAsync();
    await vi.runOnlyPendingTimersAsync();

    routeTmuxTransportOutput(
      transportTerminalId,
      [
        "%begin 1 0",
        "@1\thappy\t1\t*",
        "%end 1 0",
        "%begin 2 0",
        "@1\t%1\t0\t0\t80\t24\t1\t/home/bobren\t2\t3\t0\t3",
        "%end 2 0",
        "",
      ].join("\n")
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await vi.runOnlyPendingTimersAsync();
    expect(writeTerminalMock).toHaveBeenLastCalledWith(
      transportTerminalId,
      "capture-pane -p -e -C -S -3 -t %1\n"
    );

    routeTmuxTransportOutput(
      transportTerminalId,
      [
        "%begin 3 0",
        "history row",
        "full screen row",
        "%end 3 0",
        "",
      ].join("\n")
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const writeCalls = writeTerminalMock.mock.calls as unknown as Array<[string, string]>;
    expect(writeCalls.filter(([, data]) => data.startsWith("capture-pane"))).toEqual([
      [transportTerminalId, "capture-pane -p -e -C -S -3 -t %1\n"],
    ]);

    const paneTerminalId = getPaneTerminalIdByPaneId("%1");
    expect(queueTerminalOutputMock).toHaveBeenCalledWith(
      paneTerminalId,
      "\u001b[0m\u001b[?7l\u001b[H\u001b[2J\u001b[3Jhistory row\r\nfull screen row\u001b[?7h\u001b[0m\u001b[4;3H",
      {
        recordActivity: false,
        allowParkedWrite: true,
        replaceBufferedOutput: true,
        clearScrollbackBeforeWrite: true,
      }
    );
  });

  it("recaptures full tmux history on focus after an initially empty pane gains scrollback", async () => {
    const transportTerminalId = "transport-history-refresh-after-empty";
    seedTransportTerminal(transportTerminalId);

    await hydrateSingleWindow(transportTerminalId);
    const paneTerminalId = getPaneTerminalIdByPaneId("%1");
    writeTerminalMock.mockClear();
    queueTerminalOutputMock.mockClear();

    routeTmuxTransportOutput(transportTerminalId, "%layout-change @1\n");
    await vi.runOnlyPendingTimersAsync();
    routeTmuxTransportOutput(
      transportTerminalId,
      [
        "%begin 4 0",
        "@1\thappy\t1\t*",
        "%end 4 0",
        "%begin 5 0",
        "@1\t%1\t0\t0\t80\t24\t1\t/Users/bobren\t4\t7\t0\t88",
        "%end 5 0",
        "",
      ].join("\n")
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    writeTerminalMock.mockClear();
    queueTerminalOutputMock.mockClear();
    handleTmuxTerminalFocus(paneTerminalId);

    expect(writeTerminalMock).toHaveBeenCalledWith(
      transportTerminalId,
      "capture-pane -p -e -C -S -88 -t %1\n"
    );
    expect(writeTerminalMock).not.toHaveBeenCalledWith(
      transportTerminalId,
      "capture-pane -p -e -C -t %1\n"
    );

    routeTmuxTransportOutput(
      transportTerminalId,
      [
        "%begin 6 0",
        "%end 6 0",
        "%begin 7 0",
        "history row",
        "current row",
        "%end 7 0",
        "%begin 8 0",
        "%end 8 0",
        "",
      ].join("\n")
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(queueTerminalOutputMock).toHaveBeenCalledWith(
      paneTerminalId,
      "\u001b[0m\u001b[?7l\u001b[H\u001b[2J\u001b[3Jhistory row\r\ncurrent row\u001b[?7h\u001b[0m\u001b[8;5H",
      {
        recordActivity: false,
        allowParkedWrite: true,
        replaceBufferedOutput: true,
        clearScrollbackBeforeWrite: true,
      }
    );
  });

  it("recaptures fallback tmux history on focus after hidden pane output", async () => {
    const transportTerminalId = "transport-hidden-output-history";
    seedTransportTerminal(transportTerminalId);

    await hydrateSingleWindow(transportTerminalId);
    const paneTerminalId = getPaneTerminalIdByPaneId("%1");
    useTerminalStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        other: makeTerminalSession("other"),
      },
      activeTerminalId: "other",
    }));
    writeTerminalMock.mockClear();
    queueTerminalOutputMock.mockClear();

    routeTmuxTransportOutput(transportTerminalId, "%output %1 hidden output\n");
    handleTmuxTerminalFocus(paneTerminalId);

    expect(writeTerminalMock).toHaveBeenCalledWith(
      transportTerminalId,
      "capture-pane -p -e -C -S -50000 -t %1\n"
    );
  });

  it("uses a fresh tmux cursor position when replaying content after pane output", async () => {
    const transportTerminalId = "transport-stale-cursor-replay";
    seedTransportTerminal(transportTerminalId);

    await hydrateSingleWindow(transportTerminalId);
    const paneTerminalId = getPaneTerminalIdByPaneId("%1");
    useTerminalStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        other: makeTerminalSession("other"),
      },
      activeTerminalId: "other",
    }));
    writeTerminalMock.mockClear();
    queueTerminalOutputMock.mockClear();

    routeTmuxTransportOutput(transportTerminalId, "%output %1 hidden output\n");
    handleTmuxTerminalFocus(paneTerminalId);
    expect(writeTerminalMock).toHaveBeenCalledWith(
      transportTerminalId,
      "capture-pane -p -e -C -S -50000 -t %1\n"
    );

    routeTmuxTransportOutput(
      transportTerminalId,
      [
        "%begin 4 0",
        "%end 4 0",
        "%begin 5 0",
        "fresh captured screen",
        "%end 5 0",
        "%begin 6 0",
        "%end 6 0",
        "",
      ].join("\n")
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(writeTerminalMock).toHaveBeenCalledWith(
      transportTerminalId,
      'display-message -p -t %1 "#{cursor_x}\\t#{cursor_y}"\n'
    );

    completeTmuxCommandWithLines(transportTerminalId, 7, ["12\t15"]);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(queueTerminalOutputMock).toHaveBeenCalledWith(
      paneTerminalId,
      "\u001b[0m\u001b[?7l\u001b[H\u001b[2J\u001b[3Jfresh captured screen\u001b[?7h\u001b[0m\u001b[16;13H",
      {
        recordActivity: false,
        allowParkedWrite: true,
        replaceBufferedOutput: true,
        clearScrollbackBeforeWrite: true,
      }
    );
    expect(queueTerminalOutputMock).not.toHaveBeenCalledWith(
      paneTerminalId,
      expect.stringContaining("\u001b[8;5H"),
      expect.anything()
    );
  });

  it("does not apply a full history capture after newer pane output arrives", async () => {
    const transportTerminalId = "transport-raced-history-capture";
    seedTransportTerminal(transportTerminalId);

    await hydrateSingleWindow(transportTerminalId);
    const paneTerminalId = getPaneTerminalIdByPaneId("%1");
    useTerminalStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        other: makeTerminalSession("other"),
      },
      activeTerminalId: "other",
    }));
    writeTerminalMock.mockClear();
    queueTerminalOutputMock.mockClear();

    routeTmuxTransportOutput(transportTerminalId, "%output %1 hidden output\n");
    handleTmuxTerminalFocus(paneTerminalId);
    expect(writeTerminalMock).toHaveBeenCalledWith(
      transportTerminalId,
      "capture-pane -p -e -C -S -50000 -t %1\n"
    );

    routeTmuxTransportOutput(transportTerminalId, "%output %1 live after focus\n");
    routeTmuxTransportOutput(
      transportTerminalId,
      [
        "%begin 4 0",
        "%end 4 0",
        "%begin 5 0",
        "stale full history",
        "%end 5 0",
        "%begin 6 0",
        "%end 6 0",
        "",
      ].join("\n")
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(queueTerminalOutputMock).toHaveBeenCalledWith(
      paneTerminalId,
      "live after focus",
      { recordActivity: false }
    );
    expect(queueTerminalOutputMock).not.toHaveBeenCalledWith(
      paneTerminalId,
      expect.stringContaining("stale full history"),
      expect.anything()
    );
  });

  it("retries an initial full-history capture after live output races the first replay", async () => {
    const transportTerminalId = "transport-initial-history-race-retry";
    seedTransportTerminal(transportTerminalId);

    await hydrateSingleWindow(transportTerminalId, { captureInitialContent: false });
    const { paneTerminalId } = getHydratedTmuxIds();
    useTerminalStore.setState({ activeTerminalId: paneTerminalId });
    writeTerminalMock.mockClear();
    queueTerminalOutputMock.mockClear();

    await vi.runOnlyPendingTimersAsync();
    expect(writeTerminalMock).toHaveBeenCalledWith(
      transportTerminalId,
      "capture-pane -p -e -C -t %1\n"
    );

    routeTmuxTransportOutput(transportTerminalId, "%output %1 live before initial replay\n");
    completeTmuxCommandWithLines(transportTerminalId, 3, ["stale initial history"]);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(queueTerminalOutputMock).toHaveBeenCalledWith(
      paneTerminalId,
      "live before initial replay"
    );
    expect(queueTerminalOutputMock).not.toHaveBeenCalledWith(
      paneTerminalId,
      expect.stringContaining("stale initial history"),
      expect.anything()
    );

    writeTerminalMock.mockClear();
    queueTerminalOutputMock.mockClear();
    await vi.advanceTimersByTimeAsync(700);
    expect(writeTerminalMock).toHaveBeenCalledWith(
      transportTerminalId,
      "capture-pane -p -e -C -t %1\n"
    );

    completeTmuxCommandWithLines(transportTerminalId, 4, ["fresh initial history"]);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(writeTerminalMock).toHaveBeenCalledWith(
      transportTerminalId,
      'display-message -p -t %1 "#{cursor_x}\\t#{cursor_y}"\n'
    );

    completeTmuxCommandWithLines(transportTerminalId, 5, ["4\t7"]);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(queueTerminalOutputMock).toHaveBeenCalledWith(
      paneTerminalId,
      "\u001b[0m\u001b[?7l\u001b[H\u001b[2J\u001b[3Jfresh initial history\u001b[?7h\u001b[0m\u001b[8;5H",
      {
        recordActivity: false,
        allowParkedWrite: true,
        replaceBufferedOutput: true,
        clearScrollbackBeforeWrite: true,
      }
    );
  });

  it("retries a focused full-history capture after live output races the first replay", async () => {
    const transportTerminalId = "transport-history-race-retry";
    seedTransportTerminal(transportTerminalId);

    await hydrateSingleWindow(transportTerminalId);
    const paneTerminalId = getPaneTerminalIdByPaneId("%1");
    useTerminalStore.setState({ activeTerminalId: paneTerminalId });

    routeTmuxTransportOutput(transportTerminalId, "%layout-change @1\n");
    await vi.runOnlyPendingTimersAsync();
    routeTmuxTransportOutput(
      transportTerminalId,
      [
        "%begin 4 0",
        "@1\thappy\t1\t*",
        "%end 4 0",
        "%begin 5 0",
        "@1\t%1\t0\t0\t80\t24\t1\t/Users/bobren\t4\t7\t0\t12",
        "%end 5 0",
        "",
      ].join("\n")
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_600);

    writeTerminalMock.mockClear();
    queueTerminalOutputMock.mockClear();
    handleTmuxTerminalFocus(paneTerminalId);
    expect(writeTerminalMock).toHaveBeenCalledWith(
      transportTerminalId,
      "capture-pane -p -e -C -S -12 -t %1\n"
    );

    routeTmuxTransportOutput(transportTerminalId, "%output %1 live after focus\n");
    routeTmuxTransportOutput(
      transportTerminalId,
      [
        "%begin 6 0",
        "%end 6 0",
        "%begin 7 0",
        "stale full history",
        "%end 7 0",
        "%begin 8 0",
        "%end 8 0",
        "",
      ].join("\n")
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(queueTerminalOutputMock).toHaveBeenCalledWith(
      paneTerminalId,
      "live after focus",
      { recordActivity: false }
    );
    expect(queueTerminalOutputMock).not.toHaveBeenCalledWith(
      paneTerminalId,
      expect.stringContaining("stale full history"),
      expect.anything()
    );

    writeTerminalMock.mockClear();
    queueTerminalOutputMock.mockClear();
    await vi.advanceTimersByTimeAsync(700);
    expect(writeTerminalMock).toHaveBeenCalledWith(
      transportTerminalId,
      "capture-pane -p -e -C -S -12 -t %1\n"
    );

    routeTmuxTransportOutput(
      transportTerminalId,
      [
        "%begin 9 0",
        "fresh full history",
        "%end 9 0",
        "",
      ].join("\n")
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(writeTerminalMock).toHaveBeenCalledWith(
      transportTerminalId,
      'display-message -p -t %1 "#{cursor_x}\\t#{cursor_y}"\n'
    );

    completeTmuxCommandWithLines(transportTerminalId, 10, ["4\t7"]);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(queueTerminalOutputMock).toHaveBeenCalledWith(
      paneTerminalId,
      "\u001b[0m\u001b[?7l\u001b[H\u001b[2J\u001b[3Jfresh full history\u001b[?7h\u001b[0m\u001b[8;5H",
      {
        recordActivity: false,
        allowParkedWrite: true,
        replaceBufferedOutput: true,
        clearScrollbackBeforeWrite: true,
      }
    );
  });

  it("throttles repeated fallback history refreshes after hidden pane output", async () => {
    const transportTerminalId = "transport-hidden-output-cooldown";
    seedTransportTerminal(transportTerminalId);

    await hydrateSingleWindow(transportTerminalId);
    const paneTerminalId = getPaneTerminalIdByPaneId("%1");
    useTerminalStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        other: makeTerminalSession("other"),
      },
      activeTerminalId: "other",
    }));
    writeTerminalMock.mockClear();
    queueTerminalOutputMock.mockClear();

    routeTmuxTransportOutput(transportTerminalId, "%output %1 hidden output\n");
    handleTmuxTerminalFocus(paneTerminalId);
    expect(writeTerminalMock).toHaveBeenCalledWith(
      transportTerminalId,
      "capture-pane -p -e -C -S -50000 -t %1\n"
    );

    routeTmuxTransportOutput(
      transportTerminalId,
      [
        "%begin 4 0",
        "%end 4 0",
        "%begin 5 0",
        "current screen",
        "%end 5 0",
        "%begin 6 0",
        "%end 6 0",
        "",
      ].join("\n")
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(writeTerminalMock).toHaveBeenCalledWith(
      transportTerminalId,
      'display-message -p -t %1 "#{cursor_x}\\t#{cursor_y}"\n'
    );
    completeTmuxCommandWithLines(transportTerminalId, 7, ["4\t7"]);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    useTerminalStore.setState({ activeTerminalId: "other" });
    writeTerminalMock.mockClear();
    queueTerminalOutputMock.mockClear();

    routeTmuxTransportOutput(transportTerminalId, "%output %1 more hidden output\n");
    handleTmuxTerminalFocus(paneTerminalId);

    const writes = (writeTerminalMock.mock.calls as unknown as Array<[string, string]>)
      .map(([, data]) => data);
    expect(writes).toContain("capture-pane -p -e -C -t %1\n");
    expect(writes).not.toContain("capture-pane -p -e -C -S -50000 -t %1\n");
  });

  it("uses bounded history refresh after hidden output when history size is known", async () => {
    const transportTerminalId = "transport-hidden-output-known-history";
    seedTransportTerminal(transportTerminalId);

    await hydrateSingleWindow(transportTerminalId);
    const paneTerminalId = getPaneTerminalIdByPaneId("%1");

    routeTmuxTransportOutput(transportTerminalId, "%layout-change @1\n");
    await vi.runOnlyPendingTimersAsync();
    routeTmuxTransportOutput(
      transportTerminalId,
      [
        "%begin 4 0",
        "@1\thappy\t1\t*",
        "%end 4 0",
        "%begin 5 0",
        "@1\t%1\t0\t0\t80\t24\t1\t/Users/bobren\t4\t7\t0\t12",
        "%end 5 0",
        "",
      ].join("\n")
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    handleTmuxTerminalFocus(paneTerminalId);
    expect(writeTerminalMock).toHaveBeenCalledWith(
      transportTerminalId,
      "capture-pane -p -e -C -S -12 -t %1\n"
    );
    routeTmuxTransportOutput(
      transportTerminalId,
      [
        "%begin 6 0",
        "%end 6 0",
        "%begin 7 0",
        "history row",
        "current row",
        "%end 7 0",
        "%begin 8 0",
        "%end 8 0",
        "",
      ].join("\n")
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    useTerminalStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        other: makeTerminalSession("other"),
      },
      activeTerminalId: "other",
    }));
    vi.advanceTimersByTime(30_001);
    writeTerminalMock.mockClear();

    routeTmuxTransportOutput(transportTerminalId, "%output %1 hidden output\n");
    handleTmuxTerminalFocus(paneTerminalId);

    const writes = (writeTerminalMock.mock.calls as unknown as Array<[string, string]>)
      .map(([, data]) => data);
    expect(writes).toContain("capture-pane -p -e -C -S -12 -t %1\n");
    expect(writes).not.toContain("capture-pane -p -e -C -S -50000 -t %1\n");
  });

  it("captures the active tmux pane history before lazy background panes", async () => {
    const transportTerminalId = "transport-lazy-history";
    seedTransportTerminal(transportTerminalId);

    routeTmuxTransportOutput(transportTerminalId, TMUX_CONTROL_START);
    await vi.runOnlyPendingTimersAsync();
    await vi.runOnlyPendingTimersAsync();

    routeTmuxTransportOutput(
      transportTerminalId,
      [
        "%begin 1 0",
        "@1\tone\t0\t-",
        "@2\ttwo\t1\t*",
        "%end 1 0",
        "%begin 2 0",
        "@1\t%1\t0\t0\t80\t24\t1\t/Users/bobren/one\t4\t7\t0",
        "@2\t%2\t0\t0\t80\t24\t1\t/Users/bobren/two\t1\t2\t0",
        "%end 2 0",
        "",
      ].join("\n")
    );
    await Promise.resolve();
    await Promise.resolve();

    const writeCalls = writeTerminalMock.mock.calls as unknown as Array<[string, string]>;
    expect(writeCalls.some(([, data]) => data.startsWith("capture-pane"))).toBe(false);

    await vi.runOnlyPendingTimersAsync();
    expect(writeTerminalMock).toHaveBeenLastCalledWith(
      transportTerminalId,
      "capture-pane -p -e -C -t %2\n"
    );
    routeTmuxTransportOutput(
      transportTerminalId,
      [
        "%begin 3 0",
        "active pane",
        "%end 3 0",
        "",
      ].join("\n")
    );
    await Promise.resolve();
    await Promise.resolve();

    await vi.runOnlyPendingTimersAsync();
    expect(writeTerminalMock).toHaveBeenLastCalledWith(
      transportTerminalId,
      "capture-pane -p -e -C -t %1\n"
    );
    routeTmuxTransportOutput(
      transportTerminalId,
      [
        "%begin 4 0",
        "background pane",
        "%end 4 0",
        "",
      ].join("\n")
    );
    await Promise.resolve();
    await Promise.resolve();
  });

  it("syncs tmux window size when a pane viewport resizes", async () => {
    const transportTerminalId = "transport-pane-resize";
    seedTransportTerminal(transportTerminalId);

    await hydrateSingleWindow(transportTerminalId);
    await Promise.resolve();
    await Promise.resolve();
    routeTmuxTransportOutput(
      transportTerminalId,
      [
        "%begin 3 0",
        "initial screen",
        "%end 3 0",
        "",
      ].join("\n")
    );
    await Promise.resolve();
    await Promise.resolve();
    writeTerminalMock.mockClear();
    queueTerminalOutputMock.mockClear();

    const paneTerminalId = getPaneTerminalIdByPaneId("%1");
    expect(syncTmuxWindowSizeFromPaneTerminal(paneTerminalId)).toBe(true);
    expect(writeTerminalMock).toHaveBeenLastCalledWith(
      transportTerminalId,
      "refresh-client -C 80x24\n"
    );
    routeTmuxTransportOutput(
      transportTerminalId,
      [
        "%begin 4 0",
        "%end 4 0",
        "",
      ].join("\n")
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await vi.runOnlyPendingTimersAsync();
    routeTmuxTransportOutput(
      transportTerminalId,
      [
        "%begin 5 0",
        "@1\thappy\t1\t*",
        "%end 5 0",
        "%begin 6 0",
        "@1\t%1\t0\t0\t80\t24\t1\t/Users/bobren\t4\t7\t0\t0",
        "%end 6 0",
        "",
      ].join("\n")
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await settleFrontendLayoutTimers();
    expect(writeTerminalMock).toHaveBeenLastCalledWith(
      transportTerminalId,
      "capture-pane -p -e -C -t %1\n"
    );
    routeTmuxTransportOutput(
      transportTerminalId,
      [
        "%begin 7 0",
        "clean screen",
        "%end 7 0",
        "",
      ].join("\n")
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(queueTerminalOutputMock).toHaveBeenCalledWith(
      paneTerminalId,
      "\u001b[0m\u001b[?7l\u001b[H\u001b[2Jclean screen\u001b[?7h\u001b[0m\u001b[8;5H",
      { recordActivity: false, replaceBufferedOutput: true }
    );

    expect(syncTmuxWindowSizeFromPaneTerminal(paneTerminalId)).toBe(false);
  });

  it("resends tmux client size when a single pane snapshot is stale", async () => {
    const transportTerminalId = "transport-stale-pane-grid-resize";
    seedTransportTerminal(transportTerminalId);
    getTerminalViewportSizeMock.mockReturnValue({ width: 640, height: 480 });

    await hydrateSingleWindow(transportTerminalId);
    writeTerminalMock.mockClear();
    syncTerminalFrontendSizeMock.mockClear();

    const paneTerminalId = getPaneTerminalIdByPaneId("%1");
    expect(syncTmuxWindowSizeFromPaneTerminal(paneTerminalId)).toBe(true);
    expect(syncTerminalFrontendSizeMock).toHaveBeenCalledWith(
      paneTerminalId,
      80,
      30
    );
    expect(writeTerminalMock).toHaveBeenLastCalledWith(
      transportTerminalId,
      "refresh-client -C 80x30\n"
    );

    writeTerminalMock.mockClear();
    syncTerminalFrontendSizeMock.mockClear();

    // No layout-change has arrived yet, so tmux still says the pane is 80x24.
    // The old code trusted the cached 80x30 client size and stopped here,
    // leaving xterm and tmux free to disagree until another split/layout event.
    expect(syncTmuxWindowSizeFromPaneTerminal(paneTerminalId)).toBe(true);
    expect(syncTerminalFrontendSizeMock).toHaveBeenCalledWith(
      paneTerminalId,
      80,
      30
    );
    expect(writeTerminalMock).toHaveBeenLastCalledWith(
      transportTerminalId,
      "refresh-client -C 80x30\n"
    );
  });

  it("reconciles a single pane frontend even when the tmux client size is unchanged", async () => {
    const transportTerminalId = "transport-stale-frontend-grid-resize";
    seedTransportTerminal(transportTerminalId);

    await hydrateSingleWindow(transportTerminalId);
    const paneTerminalId = getPaneTerminalIdByPaneId("%1");
    expect(syncTmuxWindowSizeFromPaneTerminal(paneTerminalId)).toBe(true);

    writeTerminalMock.mockClear();
    syncTerminalFrontendSizeMock.mockClear();

    // tmux and the viewport agree, but the local xterm can still be stale after
    // a sleep/wake or missed ResizeObserver event. Reassert the pane size even
    // when no refresh-client command is needed.
    expect(syncTmuxWindowSizeFromPaneTerminal(paneTerminalId)).toBe(false);
    expect(syncTerminalFrontendSizeMock).toHaveBeenCalledWith(
      paneTerminalId,
      80,
      24
    );
    expect(writeTerminalMock).not.toHaveBeenCalledWith(
      transportTerminalId,
      "refresh-client -C 80x24\n"
    );
  });

  it("syncs tmux window size from the root canvas instead of stale pane ratios", async () => {
    const transportTerminalId = "transport-root-canvas-resize";
    seedTransportTerminal(transportTerminalId);

    await hydrateSplitWindow(transportTerminalId);
    writeTerminalMock.mockClear();

    const windowTerminalId = getWindowTerminalIdByWindowId("@1");
    expect(syncTmuxWindowSize(windowTerminalId, 640, 320)).toBe(true);
    expect(writeTerminalMock).toHaveBeenLastCalledWith(
      transportTerminalId,
      "refresh-client -C 80x20\n"
    );
  });

  it("does not resend the same tmux client size for sibling windows", async () => {
    const transportTerminalId = "transport-client-size-once";
    seedTransportTerminal(transportTerminalId);

    await hydrateTwoWindows(transportTerminalId);
    writeTerminalMock.mockClear();

    const firstWindowTerminalId = getWindowTerminalIdByWindowId("@1");
    const secondWindowTerminalId = getWindowTerminalIdByWindowId("@2");
    expect(syncTmuxWindowSize(firstWindowTerminalId, 640, 384)).toBe(true);
    expect(syncTmuxWindowSize(secondWindowTerminalId, 640, 384)).toBe(false);

    const writeCalls = writeTerminalMock.mock.calls as unknown as Array<[string, string]>;
    const refreshClientWrites = writeCalls.filter(
      ([, data]) => data === "refresh-client -C 80x24\n"
    );
    expect(refreshClientWrites).toHaveLength(1);
  });

  it("does not refresh every tmux window after a client resize layout burst", async () => {
    const transportTerminalId = "transport-client-resize-layout-burst";
    seedTransportTerminal(transportTerminalId);

    await hydrateTwoWindows(transportTerminalId);
    writeTerminalMock.mockClear();

    const firstWindowTerminalId = getWindowTerminalIdByWindowId("@1");
    expect(syncTmuxWindowSize(firstWindowTerminalId, 640, 384)).toBe(true);
    routeTmuxTransportOutput(
      transportTerminalId,
      [
        "%begin 30 0",
        "%end 30 0",
        "%layout-change @1 1111,80x24,0,0,1 1111,80x24,0,0,1 *",
        "%layout-change @2 2222,80x24,0,0,2 2222,80x24,0,0,2 -",
        "",
      ].join("\n")
    );
    await Promise.resolve();
    await Promise.resolve();
    await vi.runOnlyPendingTimersAsync();

    const writes = (writeTerminalMock.mock.calls as unknown as Array<[string, string]>)
      .map(([, data]) => data);
    expect(writes.some((data) => data.includes("display-message -p -t @1"))).toBe(true);
    expect(writes.some((data) => data.includes("list-panes -t @1"))).toBe(true);
    expect(writes.some((data) => data.includes("display-message -p -t @2"))).toBe(false);
    expect(writes.some((data) => data.includes("list-panes -t @2"))).toBe(false);
  });

  it("does not treat sibling tmux window output during client resize as activity", async () => {
    const transportTerminalId = "transport-client-resize-output-activity";
    seedTransportTerminal(transportTerminalId);

    await hydrateTwoWindows(transportTerminalId);
    writeTerminalMock.mockClear();
    queueTerminalOutputMock.mockClear();

    const firstWindowTerminalId = getWindowTerminalIdByWindowId("@1");
    const secondPaneTerminalId = getPaneTerminalIdByPaneId("%2");
    expect(syncTmuxWindowSize(firstWindowTerminalId, 640, 384)).toBe(true);

    expect(getActiveStatusResizeSuppression([secondPaneTerminalId])).toMatchObject({
      terminalId: secondPaneTerminalId,
      reason: "tmux-client-resize",
    });

    routeTmuxTransportOutput(
      transportTerminalId,
      "%output %2 resize redraw from sibling window\n"
    );

    expect(queueTerminalOutputMock).toHaveBeenCalledWith(
      secondPaneTerminalId,
      "resize redraw from sibling window",
      { recordActivity: false }
    );
  });

  it("does not let split pane resize observers fight the tmux window size", async () => {
    const transportTerminalId = "transport-split-pane-resize-skip";
    seedTransportTerminal(transportTerminalId);

    await hydrateSplitWindow(transportTerminalId);
    writeTerminalMock.mockClear();

    const leftPaneTerminalId = getPaneTerminalIdByPaneId("%1");
    expect(syncTmuxWindowSizeFromPaneTerminal(leftPaneTerminalId)).toBe(false);
    expect(writeTerminalMock).not.toHaveBeenCalledWith(
      transportTerminalId,
      "refresh-client -C 80x24\n"
    );
  });

  it("redraws tmux panes when a layout refresh changes pane geometry", async () => {
    const transportTerminalId = "transport-layout-redraw";
    seedTransportTerminal(transportTerminalId);

    await hydrateSplitWindow(transportTerminalId);
    writeTerminalMock.mockClear();
    queueTerminalOutputMock.mockClear();

    const leftPaneTerminalId = getPaneTerminalIdByPaneId("%1");
    const rightPaneTerminalId = getPaneTerminalIdByPaneId("%2");

    routeTmuxTransportOutput(transportTerminalId, "%layout-change @1\n");
    await vi.runOnlyPendingTimersAsync();
    routeTmuxTransportOutput(
      transportTerminalId,
      [
        "%begin 5 0",
        "@1\thappy\t1\t*",
        "%end 5 0",
        "%begin 6 0",
        "@1\t%1\t0\t0\t50\t24\t1\t/Users/bobren/left\t4\t7\t0\t0",
        "@1\t%2\t50\t0\t30\t24\t0\t/Users/bobren/right\t1\t2\t0\t0",
        "%end 6 0",
        "",
      ].join("\n")
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await settleFrontendLayoutTimers();

    expect(writeTerminalMock).toHaveBeenCalledWith(
      transportTerminalId,
      "capture-pane -p -e -C -t %1\n"
    );
    expect(writeTerminalMock).toHaveBeenCalledWith(
      transportTerminalId,
      "capture-pane -p -e -C -t %2\n"
    );

    routeTmuxTransportOutput(
      transportTerminalId,
      [
        "%begin 7 0",
        "left clean",
        "%end 7 0",
        "%begin 8 0",
        "right clean",
        "%end 8 0",
        "",
      ].join("\n")
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(queueTerminalOutputMock).toHaveBeenCalledWith(
      leftPaneTerminalId,
      "\u001b[0m\u001b[?7l\u001b[H\u001b[2Jleft clean\u001b[?7h\u001b[0m\u001b[8;5H",
      { recordActivity: false, replaceBufferedOutput: true }
    );
    expect(queueTerminalOutputMock).toHaveBeenCalledWith(
      rightPaneTerminalId,
      "\u001b[0m\u001b[?7l\u001b[H\u001b[2Jright clean\u001b[?7h\u001b[0m\u001b[3;2H",
      { recordActivity: false, replaceBufferedOutput: true }
    );
  });

  it("fences live pane output while a layout redraw is pending", async () => {
    const transportTerminalId = "transport-layout-redraw-output-barrier";
    seedTransportTerminal(transportTerminalId);

    await hydrateSingleWindow(transportTerminalId);
    const paneTerminalId = getPaneTerminalIdByPaneId("%1");
    useTerminalStore.getState().setActiveTerminal(paneTerminalId);
    writeTerminalMock.mockClear();
    queueTerminalOutputMock.mockClear();

    routeTmuxTransportOutput(transportTerminalId, "%layout-change @1\n");
    routeTmuxTransportOutput(
      transportTerminalId,
      "%output %1 \\033[31;2H\\033[Klive during resize\n"
    );
    expect(
      queueTerminalOutputMock.mock.calls.some(
        ([terminalId, data]) =>
          terminalId === paneTerminalId
          && String(data).includes("live during resize")
      )
    ).toBe(false);

    await vi.runOnlyPendingTimersAsync();
    routeTmuxTransportOutput(
      transportTerminalId,
      [
        "%begin 4 0",
        "@1\thappy\t1\t*",
        "%end 4 0",
        "%begin 5 0",
        "@1\t%1\t0\t0\t80\t30\t1\t/Users/bobren\t4\t7\t0\t0",
        "%end 5 0",
        "",
      ].join("\n")
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await settleFrontendLayoutTimers();

    expect(writeTerminalMock).toHaveBeenCalledWith(
      transportTerminalId,
      "capture-pane -p -e -C -t %1\n"
    );
  });

  it("settles the React pane layout before resizing and redrawing a collapsed tmux split", async () => {
    const transportTerminalId = "transport-collapse-settles-layout";
    seedTransportTerminal(transportTerminalId);

    await hydrateSplitWindow(transportTerminalId);
    writeTerminalMock.mockClear();
    queueTerminalOutputMock.mockClear();
    syncTerminalFrontendSizeMock.mockClear();

    const windowTerminalId = getWindowTerminalIdByWindowId("@1");
    const rightPaneTerminalId = getPaneTerminalIdByPaneId("%2");
    let layoutDuringSync = useLayoutStore.getState().layouts[windowTerminalId];
    syncTerminalFrontendSizeMock.mockImplementation(() => {
      layoutDuringSync = useLayoutStore.getState().layouts[windowTerminalId];
    });

    routeTmuxTransportOutput(transportTerminalId, "%layout-change @1\n");
    await vi.runOnlyPendingTimersAsync();
    routeTmuxTransportOutput(
      transportTerminalId,
      [
        "%begin 5 0",
        "@1\thappy\t1\t*",
        "%end 5 0",
        "%begin 6 0",
        "@1\t%2\t0\t0\t80\t24\t1\t/Users/bobren/right\t1\t2\t0\t0",
        "%end 6 0",
        "",
      ].join("\n")
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(useLayoutStore.getState().layouts[windowTerminalId]).toEqual({
      type: "terminal",
      id: expect.any(String),
      terminalId: rightPaneTerminalId,
    });
    expect(syncTerminalFrontendSizeMock).not.toHaveBeenCalled();

    await settleFrontendLayoutTimers();

    expect(layoutDuringSync).toEqual({
      type: "terminal",
      id: expect.any(String),
      terminalId: rightPaneTerminalId,
    });
    expect(syncTerminalFrontendSizeMock).toHaveBeenCalledWith(
      rightPaneTerminalId,
      80,
      24
    );

    const syncOrder = syncTerminalFrontendSizeMock.mock.invocationCallOrder[0];
    const captureCallIndex = (writeTerminalMock.mock.calls as unknown as Array<[string, string]>).findIndex(
      ([, command]) => command === "capture-pane -p -e -C -t %2\n"
    );
    expect(captureCallIndex).toBeGreaterThanOrEqual(0);
    expect(syncOrder).toBeLessThan(
      writeTerminalMock.mock.invocationCallOrder[captureCallIndex]
    );

    routeTmuxTransportOutput(
      transportTerminalId,
      [
        "%begin 7 0",
        "right full height",
        "%end 7 0",
        "",
      ].join("\n")
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(queueTerminalOutputMock).toHaveBeenCalledWith(
      rightPaneTerminalId,
      "\u001b[0m\u001b[?7l\u001b[H\u001b[2Jright full height\u001b[?7h\u001b[0m\u001b[3;2H",
      { recordActivity: false, replaceBufferedOutput: true }
    );
  });

  it("does not repair full pane history during a layout refresh", async () => {
    const transportTerminalId = "transport-layout-redraw-stale-history";
    seedTransportTerminal(transportTerminalId);

    await hydrateSplitWindow(transportTerminalId);
    writeTerminalMock.mockClear();

    routeTmuxTransportOutput(transportTerminalId, "%layout-change @1\n");
    await vi.runOnlyPendingTimersAsync();
    routeTmuxTransportOutput(
      transportTerminalId,
      [
        "%begin 5 0",
        "@1\thappy\t1\t*",
        "%end 5 0",
        "%begin 6 0",
        "@1\t%1\t0\t0\t50\t24\t1\t/Users/bobren/left\t4\t7\t0\t8",
        "@1\t%2\t50\t0\t30\t24\t0\t/Users/bobren/right\t1\t2\t0\t0",
        "%end 6 0",
        "",
      ].join("\n")
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await settleFrontendLayoutTimers();

    const writes = (writeTerminalMock.mock.calls as unknown as Array<[string, string]>)
      .map(([, data]) => data);
    expect(writes).toContain("capture-pane -p -e -C -t %1\n");
    expect(writes).not.toContain("capture-pane -p -e -C -S -8 -t %1\n");
    expect(writes).not.toContain("capture-pane -p -e -C -S -50000 -t %1\n");
  });

  it("keeps user tmux split drag layout until resize-pane settles", async () => {
    const transportTerminalId = "transport-user-resize-lock";
    seedTransportTerminal(transportTerminalId);

    await hydrateSplitWindow(transportTerminalId);
    writeTerminalMock.mockClear();

    const windowTerminalId = getWindowTerminalIdByWindowId("@1");
    const leftPaneTerminalId = getPaneTerminalIdByPaneId("%1");
    const initialLayout = useLayoutStore.getState().layouts[windowTerminalId];
    expect(initialLayout?.type).toBe("split");
    if (!initialLayout || initialLayout.type !== "split") {
      return;
    }

    beginTmuxPaneResizeByTerminal(leftPaneTerminalId);
    useLayoutStore.getState().setRatio(windowTerminalId, initialLayout.id, 0.75);
    expect(syncTmuxWindowSizeFromPaneTerminal(leftPaneTerminalId)).toBe(false);
    expect(writeTerminalMock).not.toHaveBeenCalledWith(
      transportTerminalId,
      "refresh-client -C 80x24\n"
    );

    routeTmuxTransportOutput(transportTerminalId, "%layout-change @1\n");
    await vi.runOnlyPendingTimersAsync();
    routeTmuxTransportOutput(
      transportTerminalId,
      [
        "%begin 5 0",
        "@1\thappy\t1\t*",
        "%end 5 0",
        "%begin 6 0",
        "@1\t%1\t0\t0\t40\t24\t1\t/Users/bobren/left\t4\t7\t0\t0",
        "@1\t%2\t40\t0\t40\t24\t0\t/Users/bobren/right\t1\t2\t0\t0",
        "%end 6 0",
        "",
      ].join("\n")
    );
    await Promise.resolve();
    await Promise.resolve();

    const lockedLayout = useLayoutStore.getState().layouts[windowTerminalId];
    expect(lockedLayout?.type === "split" && lockedLayout.ratio).toBe(0.75);

    expect(resizeTmuxPaneByTerminal(leftPaneTerminalId, "horizontal", 10)).toBe(true);
    expect(writeTerminalMock).toHaveBeenLastCalledWith(
      transportTerminalId,
      "resize-pane -t %1 -R 10\n"
    );
    routeTmuxTransportOutput(
      transportTerminalId,
      [
        "%begin 7 0",
        "%end 7 0",
        "",
      ].join("\n")
    );
    await Promise.resolve();
    await vi.runOnlyPendingTimersAsync();
    routeTmuxTransportOutput(
      transportTerminalId,
      [
        "%begin 8 0",
        "@1\thappy\t1\t*",
        "%end 8 0",
        "%begin 9 0",
        "@1\t%1\t0\t0\t50\t24\t1\t/Users/bobren/left\t4\t7\t0\t0",
        "@1\t%2\t50\t0\t30\t24\t0\t/Users/bobren/right\t1\t2\t0\t0",
        "%end 9 0",
        "",
      ].join("\n")
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const settledLayout = useLayoutStore.getState().layouts[windowTerminalId];
    expect(settledLayout?.type).toBe("split");
    if (!settledLayout || settledLayout.type !== "split") {
      return;
    }
    expect(settledLayout.ratio).toBeCloseTo(0.625);
  });

  it("inserts Cmd+T tmux windows immediately after the focused tmux window", async () => {
    const transportTerminalId = "transport-new-window-order";
    seedTransportTerminal(transportTerminalId);

    await hydrateTwoWindows(transportTerminalId);
    await Promise.resolve();
    await Promise.resolve();
    routeTmuxTransportOutput(
      transportTerminalId,
      [
        "%begin 20 0",
        "%end 20 0",
        "%begin 21 0",
        "%end 21 0",
        "",
      ].join("\n")
    );
    await Promise.resolve();
    await Promise.resolve();
    writeTerminalMock.mockClear();

    const firstWindowTerminalId = getWindowTerminalIdByWindowId("@1");
    const secondWindowTerminalId = getWindowTerminalIdByWindowId("@2");
    const firstPaneTerminalId = getPaneTerminalIdByPaneId("%1");
    const firstNodeId = getNodeIdForTerminalId(firstWindowTerminalId);
    const secondNodeId = getNodeIdForTerminalId(secondWindowTerminalId);
    expect(useProjectStore.getState().nodes.root.children).toEqual([
      "transport-node",
      firstNodeId,
      secondNodeId,
    ]);

    useTerminalStore.getState().setActiveTerminal(firstPaneTerminalId);
    const createPromise = createTmuxWindowForTerminal(firstPaneTerminalId);
    await Promise.resolve();
    expect(writeTerminalMock).toHaveBeenLastCalledWith(
      transportTerminalId,
      "new-window -a -t @1\n"
    );

    routeTmuxTransportOutput(transportTerminalId, "%window-add @3\n");
    await vi.runOnlyPendingTimersAsync();
    routeTmuxTransportOutput(
      transportTerminalId,
      [
        "%begin 3 0",
        "%end 3 0",
        "%begin 4 0",
        "@3\tthree\t1\t*",
        "%end 4 0",
        "%begin 5 0",
        "@3\t%3\t0\t0\t80\t24\t1\t/Users/bobren/three\t0\t0\t0",
        "%end 5 0",
        "",
      ].join("\n")
    );
    await createPromise;
    await Promise.resolve();
    await Promise.resolve();

    const thirdWindowTerminalId = getWindowTerminalIdByWindowId("@3");
    const thirdPaneTerminalId = getPaneTerminalIdByPaneId("%3");
    const thirdNodeId = getNodeIdForTerminalId(thirdWindowTerminalId);
    expect(useProjectStore.getState().nodes.root.children).toEqual([
      "transport-node",
      firstNodeId,
      thirdNodeId,
      secondNodeId,
    ]);
    expect(useTerminalStore.getState().activeTerminalId).toBe(thirdPaneTerminalId);
  });

  it("does not let tmux session focus notifications activate sibling Dispatcher tabs", async () => {
    const transportTerminalId = "transport-focus-boundary";
    seedTransportTerminal(transportTerminalId);

    await hydrateTwoWindows(transportTerminalId);
    await Promise.resolve();
    await Promise.resolve();

    const firstPaneTerminalId = getPaneTerminalIdByPaneId("%1");
    const secondPaneTerminalId = getPaneTerminalIdByPaneId("%2");
    useTerminalStore.getState().setActiveTerminal(firstPaneTerminalId);
    focusTerminalInstanceMock.mockClear();

    routeTmuxTransportOutput(transportTerminalId, "%session-window-changed $0 @2\n");
    routeTmuxTransportOutput(transportTerminalId, "%window-pane-changed @2 %2\n");
    await Promise.resolve();
    await Promise.resolve();

    expect(useTerminalStore.getState().activeTerminalId).toBe(firstPaneTerminalId);
    expect(focusTerminalInstanceMock).not.toHaveBeenCalledWith(secondPaneTerminalId);
  });

  it("keeps control mode alive when captured pane content contains string terminators", async () => {
    const transportTerminalId = "transport-capture-string-terminator";
    seedTransportTerminal(transportTerminalId);

    await hydrateSingleWindow(transportTerminalId);
    const { windowTerminalId, paneTerminalId } = getHydratedTmuxIds();

    routeTmuxTransportOutput(
      transportTerminalId,
      [
        "%begin 3 0",
        `before ${TMUX_CONTROL_END} after`,
        "%end 3 0",
        "",
      ].join("\n")
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(useTerminalStore.getState().sessions[transportTerminalId]).toMatchObject({
      backendKind: "tmux-transport",
      tmuxControlSessionId: transportTerminalId,
    });
    expect(useTerminalStore.getState().sessions[windowTerminalId]).toMatchObject({
      backendKind: "tmux-window",
      tmuxControlSessionId: transportTerminalId,
      tmuxWindowId: "@1",
    });
    expect(useTerminalStore.getState().sessions[paneTerminalId]).toMatchObject({
      backendKind: "tmux-pane",
      tmuxControlSessionId: transportTerminalId,
      tmuxPaneId: "%1",
    });
  });

  it("keeps existing tmux windows when a full refresh response is not a snapshot", async () => {
    const transportTerminalId = "transport-bad-refresh";
    seedTransportTerminal(transportTerminalId);

    await hydrateSingleWindow(transportTerminalId);
    const { windowTerminalId, paneTerminalId } = getHydratedTmuxIds();

    routeTmuxTransportOutput(
      transportTerminalId,
      [
        "%begin 3 0",
        "captured pane content",
        "%end 3 0",
        "",
      ].join("\n")
    );
    await Promise.resolve();
    await Promise.resolve();

    routeTmuxTransportOutput(transportTerminalId, "%sessions-changed\n");
    await vi.runOnlyPendingTimersAsync();
    routeTmuxTransportOutput(
      transportTerminalId,
      [
        "%begin 4 0",
        "captured text is not a window snapshot",
        "%end 4 0",
        "%begin 5 0",
        "captured text is not a pane snapshot",
        "%end 5 0",
        "",
      ].join("\n")
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(useTerminalStore.getState().sessions[windowTerminalId]).toMatchObject({
      backendKind: "tmux-window",
      tmuxControlSessionId: transportTerminalId,
      tmuxWindowId: "@1",
      title: "happy",
    });
    expect(useTerminalStore.getState().sessions[paneTerminalId]).toMatchObject({
      backendKind: "tmux-pane",
      tmuxControlSessionId: transportTerminalId,
      tmuxPaneId: "%1",
    });
    expect(useLayoutStore.getState().layouts[windowTerminalId]).toBeDefined();
  });

  it("appends newly discovered windows on restore without moving existing sidebar tabs", async () => {
    const transportTerminalId = "transport-restore-order";
    seedTransportTerminal(transportTerminalId);

    useTerminalStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        "window-two": makeTerminalSession("window-two", {
          title: "two",
          backendKind: "tmux-window",
          tmuxWindowId: "@2",
        }),
        local: makeTerminalSession("local", { title: "local" }),
      },
    }));
    useProjectStore.setState((state) => ({
      nodes: {
        ...state.nodes,
        root: {
          ...state.nodes.root,
          children: ["transport-node", "window-two-node", "local-node"],
        },
        "window-two-node": {
          id: "window-two-node",
          type: "terminal",
          name: "two",
          terminalId: "window-two",
          parentId: "root",
        },
        "local-node": {
          id: "local-node",
          type: "terminal",
          name: "local",
          terminalId: "local",
          parentId: "root",
        },
      },
    }));
    useLayoutStore.setState((state) => ({
      layouts: {
        ...state.layouts,
        "window-two": {
          type: "terminal",
          id: "layout-window-two",
          terminalId: "window-two",
        },
        local: {
          type: "terminal",
          id: "layout-local",
          terminalId: "local",
        },
      },
    }));

    routeTmuxTransportOutput(transportTerminalId, TMUX_CONTROL_START);
    await vi.runOnlyPendingTimersAsync();
    await vi.runOnlyPendingTimersAsync();

    routeTmuxTransportOutput(
      transportTerminalId,
      [
        "%begin 1 0",
        "@1\tone\t0\t-",
        "@2\ttwo\t1\t*",
        "%end 1 0",
        "%begin 2 0",
        "@1\t%1\t0\t0\t80\t24\t1\t/Users/bobren/one\t4\t7\t0",
        "@2\t%2\t0\t0\t80\t24\t1\t/Users/bobren/two\t1\t2\t0",
        "%end 2 0",
        "",
      ].join("\n")
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const newWindowNodeId = getNodeIdForTerminalId(getWindowTerminalIdByWindowId("@1"));
    expect(useProjectStore.getState().nodes.root.children).toEqual([
      "transport-node",
      "window-two-node",
      "local-node",
      newWindowNodeId,
    ]);
  });

  it("still removes the Dispatcher tab when tmux reports that the window closed", async () => {
    const transportTerminalId = "transport-close";
    seedTransportTerminal(transportTerminalId);

    await hydrateSingleWindow(transportTerminalId);
    const { windowTerminalId, paneTerminalId } = getHydratedTmuxIds();

    routeTmuxTransportOutput(transportTerminalId, "%window-close @1\n");

    const terminalState = useTerminalStore.getState();
    expect(terminalState.sessions[windowTerminalId]).toBeUndefined();
    expect(terminalState.sessions[paneTerminalId]).toBeUndefined();
    expect(useLayoutStore.getState().layouts[windowTerminalId]).toBeUndefined();
    expect(Object.values(useProjectStore.getState().nodes).some((node) => node.terminalId === windowTerminalId)).toBe(false);
  });

  it("focuses the next tmux window when the active tmux window closes", async () => {
    const transportTerminalId = "transport-close-focus-next";
    seedTransportTerminal(transportTerminalId);

    await hydrateThreeWindows(transportTerminalId);
    const secondPaneTerminalId = getPaneTerminalIdByPaneId("%2");
    const thirdPaneTerminalId = getPaneTerminalIdByPaneId("%3");
    useTerminalStore.getState().setActiveTerminal(secondPaneTerminalId);
    focusTerminalInstanceMock.mockClear();

    routeTmuxTransportOutput(transportTerminalId, "%window-close @2\n");

    expect(useTerminalStore.getState().activeTerminalId).toBe(thirdPaneTerminalId);
    expect(focusTerminalInstanceMock).toHaveBeenCalledWith(thirdPaneTerminalId);
  });

  it("focuses the previous tmux window when the last active tmux window closes", async () => {
    const transportTerminalId = "transport-close-focus-previous";
    seedTransportTerminal(transportTerminalId);

    await hydrateThreeWindows(transportTerminalId);
    const secondPaneTerminalId = getPaneTerminalIdByPaneId("%2");
    const thirdPaneTerminalId = getPaneTerminalIdByPaneId("%3");
    useTerminalStore.getState().setActiveTerminal(thirdPaneTerminalId);
    focusTerminalInstanceMock.mockClear();

    routeTmuxTransportOutput(transportTerminalId, "%window-close @3\n");

    expect(useTerminalStore.getState().activeTerminalId).toBe(secondPaneTerminalId);
    expect(focusTerminalInstanceMock).toHaveBeenCalledWith(secondPaneTerminalId);
  });
});
