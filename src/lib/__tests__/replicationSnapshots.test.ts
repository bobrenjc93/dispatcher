import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const isWebClient = vi.fn(() => false);
vi.mock("../webBridge", () => ({ isWebClient: () => isWebClient() }));

const {
  forgetMirroredTerminal,
  forgetRequestedSnapshots,
  invalidateMirroredTerminal,
  mirrorTerminalOutput,
  setReplicaCount,
  setTerminalGridProvider,
  setTerminalSnapshotSource,
  showMirroredTerminals,
  startActionListener,
  startMirrorConsumer,
} = await import("../replication");
const { getClientId } = await import("../clientId");

type Frame = {
  kind: string;
  terminalId: string;
  data?: string;
  targetClientId?: string;
};

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);

function publishedFrames(): Frame[] {
  return invokeMock.mock.calls
    .filter(([cmd]) => cmd === "publish_mirror")
    .flatMap(([, args]) => (args as { payload: { frames: Frame[] } }).payload.frames);
}

function relayedSnapshotRequests(): string[] {
  return invokeMock.mock.calls
    .filter(([cmd]) => cmd === "relay_action")
    .map(([, args]) => (args as { action: { args: [string, string] } }).action.args[1]);
}

/** The callback the code under test passed to `listen` for `eventName`. */
function capturedListener<T>(eventName: string): (event: { payload: T }) => void {
  const call = [...listenMock.mock.calls].reverse().find(([name]) => name === eventName);
  if (!call) {
    throw new Error(`nothing listened for ${eventName}`);
  }
  return call[1] as unknown as (event: { payload: T }) => void;
}

async function answerSnapshotRequestFrom(targetClientId: string, terminalId: string) {
  await startActionListener();
  capturedListener<unknown>("dispatcher-action")({
    payload: {
      action: { name: "requestSnapshot", args: [targetClientId, terminalId] },
      originClientId: targetClientId,
    },
  });
}

describe("replica snapshots on the desktop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    isWebClient.mockReturnValue(false);
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    setReplicaCount(1);
    setTerminalGridProvider(() => ({ cols: 80, rows: 24 }));
    setTerminalSnapshotSource(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    setTerminalSnapshotSource(null);
    setTerminalGridProvider(null);
  });

  it("puts a captured snapshot in the stream between the output it covers and the output after", async () => {
    // A capture describes the pane at one point in the stream. Output before
    // that point is inside it and output after is not, so the snapshot has to
    // sit exactly there or the phone shows a line twice, or never.
    let deliverCapture: ((replay: string | null) => void) | null = null;
    setTerminalSnapshotSource((_terminalId, _maxBytes, deliver) => {
      deliverCapture = deliver;
      return true;
    });

    await answerSnapshotRequestFrom("phone", "pane");
    mirrorTerminalOutput("pane", "before", { retain: false });
    deliverCapture!("history and screen");
    mirrorTerminalOutput("pane", "after", { retain: false });
    await vi.advanceTimersByTimeAsync(20);

    expect(publishedFrames()).toEqual([
      { kind: "size", terminalId: "pane", cols: 80, rows: 24 },
      { kind: "output", terminalId: "pane", data: "before" },
      { kind: "reset", terminalId: "pane", targetClientId: "phone" },
      { kind: "size", terminalId: "pane", cols: 80, rows: 24, targetClientId: "phone" },
      { kind: "output", terminalId: "pane", data: "history and screen", targetClientId: "phone" },
      { kind: "output", terminalId: "pane", data: "after" },
    ]);
  });

  it("replays retained output for a terminal no backend can capture", async () => {
    setTerminalSnapshotSource(() => false);
    mirrorTerminalOutput("shell", "local history\n");

    await answerSnapshotRequestFrom("phone", "shell");
    await vi.advanceTimersByTimeAsync(20);

    expect(publishedFrames()).toContainEqual({
      kind: "output",
      terminalId: "shell",
      data: "local history\n",
      targetClientId: "phone",
    });
    forgetMirroredTerminal("shell");
  });

  it("keeps nothing for a terminal whose backend holds its own history", async () => {
    // tmux panes used to keep up to 4MB each here, on top of tmux keeping the
    // same history and the desktop's own scrollback keeping it again.
    setTerminalSnapshotSource(() => false);
    mirrorTerminalOutput("tmux-pane", "streamed\n", { retain: false });
    await vi.advanceTimersByTimeAsync(20);
    invokeMock.mockClear();

    await answerSnapshotRequestFrom("phone", "tmux-pane");
    await vi.advanceTimersByTimeAsync(20);

    expect(publishedFrames().filter((frame) => frame.kind === "output")).toEqual([]);
  });

  it("sends an empty snapshot when the capture fails, so the replica stops waiting", async () => {
    setTerminalSnapshotSource((_terminalId, _maxBytes, deliver) => {
      deliver(null);
      return true;
    });

    await answerSnapshotRequestFrom("phone", "pane");
    await vi.advanceTimersByTimeAsync(20);

    expect(publishedFrames().map((frame) => frame.kind)).toEqual(["reset", "size"]);
  });

  it("does not start a publish while the previous one is still in flight", async () => {
    // Two invokes racing could land a snapshot ahead of output it already
    // contains, which then plays a second time on top of it.
    let finishFirst: () => void = () => {};
    invokeMock.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        finishFirst = resolve;
      })
    );

    mirrorTerminalOutput("pane", "one", { retain: false });
    await vi.advanceTimersByTimeAsync(20);
    mirrorTerminalOutput("pane", "two", { retain: false });
    await vi.advanceTimersByTimeAsync(100);

    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "publish_mirror")).toHaveLength(1);

    finishFirst();
    await vi.advanceTimersByTimeAsync(20);

    const publishes = invokeMock.mock.calls.filter(([cmd]) => cmd === "publish_mirror");
    expect(publishes).toHaveLength(2);
    expect(publishedFrames().filter((frame) => frame.kind === "output").map((frame) => frame.data))
      .toEqual(["one", "two"]);
  });
});

describe("replica applying mirrored frames", () => {
  const clientId = getClientId();
  let applied: Frame[];
  let deliver: (frames: Frame[]) => void;

  beforeEach(async () => {
    vi.useFakeTimers();
    isWebClient.mockReturnValue(true);
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    forgetRequestedSnapshots();
    showMirroredTerminals([]);
    applied = [];
    await startMirrorConsumer((frame) => {
      applied.push(frame as Frame);
    });
    const listener = capturedListener<{ frames: Frame[] }>("dispatcher-mirror");
    deliver = (frames) => listener({ payload: { frames } });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("applies live output only for terminals it has asked for", () => {
    // Every pane's output is broadcast now, hidden on the desktop or not; a
    // phone building xterms for all of them would be the twenty-parser freeze
    // all over again.
    showMirroredTerminals(["shown"]);

    deliver([
      { kind: "output", terminalId: "shown", data: "yes" },
      { kind: "output", terminalId: "elsewhere", data: "no" },
    ]);

    expect(applied).toEqual([{ kind: "output", terminalId: "shown", data: "yes" }]);
  });

  it("ignores a snapshot meant for another replica", () => {
    showMirroredTerminals(["shown"]);

    deliver([
      { kind: "reset", terminalId: "shown", targetClientId: "someone-else" },
      { kind: "output", terminalId: "shown", data: "theirs", targetClientId: "someone-else" },
      { kind: "reset", terminalId: "shown", targetClientId: clientId },
      { kind: "output", terminalId: "shown", data: "mine", targetClientId: clientId },
    ]);

    expect(applied.map((frame) => frame.data ?? frame.kind)).toEqual(["reset", "mine"]);
  });

  it("asks again straight away when the desktop invalidates a terminal on screen", () => {
    showMirroredTerminals(["shown"]);
    expect(relayedSnapshotRequests()).toEqual(["shown"]);

    deliver([{ kind: "invalidate", terminalId: "shown" }]);

    expect(relayedSnapshotRequests()).toEqual(["shown", "shown"]);
    expect(applied).toEqual([]);
  });

  it("waits until an invalidated terminal off screen comes back before asking", () => {
    showMirroredTerminals(["was-shown"]);
    showMirroredTerminals(["other"]);
    expect(relayedSnapshotRequests()).toEqual(["was-shown", "other"]);

    deliver([{ kind: "invalidate", terminalId: "was-shown" }]);
    expect(relayedSnapshotRequests()).toEqual(["was-shown", "other"]);
    // Nor does it keep applying output to a copy it knows is wrong.
    deliver([{ kind: "output", terminalId: "was-shown", data: "stale" }]);
    expect(applied).toEqual([]);

    showMirroredTerminals(["was-shown"]);
    expect(relayedSnapshotRequests()).toEqual(["was-shown", "other", "was-shown"]);
  });
});

describe("invalidating from the desktop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    isWebClient.mockReturnValue(false);
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("only tells replicas when there are some", async () => {
    setReplicaCount(0);
    invalidateMirroredTerminal("pane");
    await vi.advanceTimersByTimeAsync(20);
    expect(publishedFrames()).toEqual([]);

    setReplicaCount(1);
    invalidateMirroredTerminal("pane");
    await vi.advanceTimersByTimeAsync(20);
    expect(publishedFrames()).toEqual([{ kind: "invalidate", terminalId: "pane" }]);
  });
});
