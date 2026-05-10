import { describe, expect, it } from "vitest";
import { resolveTerminalScreenshotStatus, type TerminalScreenshotStatusInput } from "../terminalScreenshotStatus";

const INACTIVITY_MS = 10_000;
const LONG_INACTIVITY_MS = 60 * 60 * 1000;

function status(patch: Partial<TerminalScreenshotStatusInput> = {}) {
  return resolveTerminalScreenshotStatus({
    hasDetectedActivity: true,
    isActiveTab: false,
    changed: false,
    now: 20_000,
    effectiveChangedAt: 1_000,
    acknowledgedTime: 0,
    wasNeedsAttention: false,
    wasPossiblyDone: false,
    inactivityMs: INACTIVITY_MS,
    longInactivityMs: LONG_INACTIVITY_MS,
    ...patch,
  });
}

describe("terminalScreenshotStatus", () => {
  it("marks an unacknowledged background tab as needing attention after it goes idle", () => {
    expect(status()).toMatchObject({
      hasAcknowledgedCurrentOutput: false,
      nextNeedsAttention: true,
      nextPossiblyDone: false,
      nextLongInactive: false,
    });
  });

  it("marks an acknowledged idle tab as possibly done", () => {
    expect(status({ acknowledgedTime: 1_000, effectiveChangedAt: 1_000 })).toMatchObject({
      staleStartedAt: 11_000,
      brownStartedAt: 11_000,
      nextNeedsAttention: false,
      nextPossiblyDone: true,
      nextLongInactive: false,
    });
  });

  it("turns a viewed pulsing tab brown without restarting the inactivity timer", () => {
    expect(status({
      isActiveTab: true,
      wasNeedsAttention: true,
      acknowledgedTime: 20_000,
      effectiveChangedAt: 1_000,
      now: 20_000,
    })).toMatchObject({
      hasAcknowledgedCurrentOutput: true,
      idleStartedAt: 1_000,
      staleStartedAt: 11_000,
      brownStartedAt: 20_000,
      shouldKeepAttentionUntilFocus: false,
      nextNeedsAttention: false,
      nextPossiblyDone: true,
      nextLongInactive: false,
    });
  });

  it("does not mark a tab brown before the acknowledged output is stale", () => {
    expect(status({
      acknowledgedTime: 5_000,
      effectiveChangedAt: 1_000,
      now: 5_000,
    })).toMatchObject({
      hasAcknowledgedCurrentOutput: true,
      brownStartedAt: null,
      nextNeedsAttention: false,
      nextPossiblyDone: false,
      nextLongInactive: false,
    });
  });

  it("keeps very old unacknowledged background output pulsing instead of turning it gray", () => {
    expect(status({
      acknowledgedTime: 0,
      effectiveChangedAt: 1_000,
      now: 1_000 + LONG_INACTIVITY_MS + INACTIVITY_MS + 1,
    })).toMatchObject({
      hasAcknowledgedCurrentOutput: false,
      nextNeedsAttention: true,
      nextPossiblyDone: false,
      nextLongInactive: false,
    });
  });

  it("turns brown acknowledged output gray only after it has been brown for too long", () => {
    const acknowledgedTime = 20_000;
    expect(status({
      acknowledgedTime,
      effectiveChangedAt: 1_000,
      now: acknowledgedTime + LONG_INACTIVITY_MS + 1,
    })).toMatchObject({
      brownStartedAt: acknowledgedTime,
      nextNeedsAttention: false,
      nextPossiblyDone: false,
      nextLongInactive: true,
    });
  });

  it("keeps a possibly-done tab brown across focus-only samples", () => {
    expect(status({
      isActiveTab: true,
      wasPossiblyDone: true,
      acknowledgedTime: 1_000,
      effectiveChangedAt: 1_000,
    })).toMatchObject({
      shouldKeepBrownUntilInput: true,
      nextNeedsAttention: false,
      nextPossiblyDone: true,
    });
  });

  it("clears brown when the screenshot monitor sees real visual progress", () => {
    expect(status({
      changed: true,
      wasPossiblyDone: true,
      acknowledgedTime: 1_000,
      effectiveChangedAt: 15_000,
    })).toMatchObject({
      changedForStatus: true,
      shouldKeepBrownUntilInput: false,
      nextNeedsAttention: false,
      nextPossiblyDone: false,
      nextLongInactive: false,
    });
  });

  it("keeps brown when a visual change is ignored as focus-only churn", () => {
    expect(status({
      changed: true,
      ignoreVisualChange: true,
      wasPossiblyDone: true,
      acknowledgedTime: 1_000,
      effectiveChangedAt: 15_000,
    })).toMatchObject({
      changedForStatus: false,
      shouldKeepBrownUntilInput: true,
      nextNeedsAttention: false,
      nextPossiblyDone: true,
      nextLongInactive: false,
    });
  });
});
