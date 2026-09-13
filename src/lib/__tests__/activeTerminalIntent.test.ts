import { describe, expect, it } from "vitest";
import {
  ACTIVE_TERMINAL_INTENT_TTL_MS,
  resolveAdoptedActiveTerminal,
} from "../activeTerminalIntent";

const NOW = 1_000_000;

describe("resolveAdoptedActiveTerminal", () => {
  it("adopts the desktop's tab when this client has not chosen one", () => {
    expect(
      resolveAdoptedActiveTerminal({ incoming: "b", intent: null, now: NOW })
    ).toEqual({ activeTerminalId: "b", intentSettled: false });
  });

  it("holds a chosen tab against a snapshot that predates the choice", () => {
    // The snapshot that reverted a push notification's tab: published before
    // the desktop heard about the tap, and naming the tab the phone was on.
    expect(
      resolveAdoptedActiveTerminal({
        incoming: "b",
        intent: { terminalId: "a", at: NOW - 500 },
        now: NOW,
      })
    ).toEqual({ activeTerminalId: "a", intentSettled: false });
  });

  it("stops holding once the desktop names the same tab", () => {
    expect(
      resolveAdoptedActiveTerminal({
        incoming: "a",
        intent: { terminalId: "a", at: NOW - 500 },
        now: NOW,
      })
    ).toEqual({ activeTerminalId: "a", intentSettled: true });
  });

  it("gives up on a choice the desktop never acknowledged", () => {
    // A request that went nowhere must not strand the replica on a tab of its
    // own choosing for the life of the page.
    expect(
      resolveAdoptedActiveTerminal({
        incoming: "b",
        intent: { terminalId: "a", at: NOW - ACTIVE_TERMINAL_INTENT_TTL_MS },
        now: NOW,
      })
    ).toEqual({ activeTerminalId: "b", intentSettled: true });
  });
});
