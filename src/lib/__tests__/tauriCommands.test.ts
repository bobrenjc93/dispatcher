import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke as tauriInvoke, type Channel } from "@tauri-apps/api/core";
import { closeTerminal, createTerminal, resizeTerminal, writeTerminal } from "../tauriCommands";
import type { TerminalOutputPayload } from "../tauriCommands";

// Mocked for every test in src/test/setup.ts.
const invoke = vi.mocked(tauriInvoke);
const channel = {} as Channel<TerminalOutputPayload>;

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function sent() {
  return invoke.mock.calls.map(([command, args]) =>
    command === "write_terminal" ? `write:${(args as { data: string }).data}` : command
  );
}

describe("sends to a terminal being created", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("wait for the create, then go in the order they were made", async () => {
    const create = deferred();
    invoke.mockImplementation(async (command: string) =>
      command === "create_terminal" ? create.promise : Promise.resolve()
    );

    const created = createTerminal("t1", channel);
    const first = writeTerminal("t1", "a");
    const resized = resizeTerminal("t1", 100, 30);
    const second = writeTerminal("t1", "b");
    const closed = closeTerminal("t1");
    await Promise.resolve();
    expect(sent()).toEqual(["create_terminal"]);

    create.resolve();
    await Promise.all([created, first, resized, second, closed]);
    expect(sent()).toEqual(["create_terminal", "write:a", "resize_terminal", "write:b", "close_terminal"]);
  });

  it("still go when the create fails", async () => {
    const create = deferred();
    invoke.mockImplementation(async (command: string) =>
      command === "create_terminal" ? create.promise : Promise.resolve()
    );

    const created = createTerminal("t1", channel);
    const write = writeTerminal("t1", "a");
    create.reject(new Error("daemon did not answer"));

    await expect(created).rejects.toThrow("daemon did not answer");
    await write;
    expect(sent()).toEqual(["create_terminal", "write:a"]);
  });

  it("do not hold up other terminals, or this one once it exists", async () => {
    const create = deferred();
    invoke.mockImplementation(async (command: string) =>
      command === "create_terminal" ? create.promise : Promise.resolve()
    );

    const created = createTerminal("t1", channel);
    await writeTerminal("t2", "elsewhere");
    expect(sent()).toEqual(["create_terminal", "write:elsewhere"]);

    create.resolve();
    await created;
    await new Promise((resolve) => setTimeout(resolve, 0));
    invoke.mockClear();
    void writeTerminal("t1", "now");
    expect(sent()).toEqual(["write:now"]);
  });
});
