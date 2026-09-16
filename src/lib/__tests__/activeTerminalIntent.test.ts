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

  it("settles on the pane when the desktop answers with the other half of the tab", () => {
    // Tapping a row on a phone picks the window terminal; the desktop answers
    // with the pane inside it, and the two ids never match. Waiting for
    // equality meant holding the window id for the full timeout -- and the
    // window owns no PTY, so everything the key bar sent during those ten
    // seconds was written to a terminal that could not take it and vanished.
    expect(
      resolveAdoptedActiveTerminal({
        incoming: "pane",
        intent: { terminalId: "window", at: NOW - 500 },
        now: NOW,
        incomingSharesTab: true,
      })
    ).toEqual({ activeTerminalId: "pane", intentSettled: true });
  });

  it("still holds a choice the desktop has not caught up with", () => {
    // The case the intent exists for: a snapshot naming an unrelated tab,
    // published before the desktop heard about the tap.
    expect(
      resolveAdoptedActiveTerminal({
        incoming: "somewhere-else",
        intent: { terminalId: "window", at: NOW - 500 },
        now: NOW,
        incomingSharesTab: false,
      })
    ).toEqual({ activeTerminalId: "window", intentSettled: false });
  });
});
