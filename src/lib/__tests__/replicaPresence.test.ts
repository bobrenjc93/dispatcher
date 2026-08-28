import { describe, expect, it, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";

const isWebClient = vi.fn(() => false);
vi.mock("../webBridge", () => ({ isWebClient: () => isWebClient() }));

const { initReplicaCount, markReplicaEventSeen, setReplicaCount, mirrorTerminalOutput } =
  await import("../replication");

const invokeMock = vi.mocked(invoke);
const mirrored = () => invokeMock.mock.calls.some(([cmd]) => cmd === "publish_mirror");

describe("replica presence", () => {
  beforeEach(() => {
    invokeMock.mockClear();
    setReplicaCount(0);
  });

  it("does not mirror when nobody is watching", async () => {
    mirrorTerminalOutput("t1", "hello");
    await new Promise((r) => setTimeout(r, 40));
    expect(mirrored()).toBe(false);
  });

  it("mirrors once a replica attaches", async () => {
    setReplicaCount(1);
    mirrorTerminalOutput("t1", "hello");
    await new Promise((r) => setTimeout(r, 40));
    expect(mirrored()).toBe(true);
  });

  // `markReplicaEventSeen` is one-way module state, so this case has to run
  // before the one below that trips it.
  it("still accepts the startup count before any event", async () => {
    initReplicaCount(2);
    mirrorTerminalOutput("t1", "hello");
    await new Promise((r) => setTimeout(r, 40));
    expect(mirrored()).toBe(true);
  });

  it("ignores a stale startup count that lands after a live event", async () => {
    // A replica connects while the initial count query is still in flight.
    markReplicaEventSeen();
    setReplicaCount(1);

    // The query finally resolves with the count from before it connected.
    initReplicaCount(0);

    mirrorTerminalOutput("t1", "hello");
    await new Promise((r) => setTimeout(r, 40));
    expect(mirrored()).toBe(true);
  });

});
