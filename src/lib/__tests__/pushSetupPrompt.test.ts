import { describe, expect, it } from "vitest";
import { isPushBlockedBySettings, shouldOfferPushSetup } from "../webPushSubscribe";

const base = {
  supported: true,
  standalone: true,
  permission: "default" as NotificationPermission,
  alreadyDismissed: false,
};

describe("shouldOfferPushSetup", () => {
  it("offers setup to a home-screen app that has not been asked", () => {
    expect(shouldOfferPushSetup(base)).toBe(true);
  });

  it("stays quiet once the question has been answered", () => {
    // A denial is permanent — the prompt cannot be shown again — so asking
    // twice wastes the one chance the user has to grant it from Settings.
    expect(shouldOfferPushSetup({ ...base, permission: "denied" })).toBe(false);
    expect(shouldOfferPushSetup({ ...base, permission: "granted" })).toBe(false);
    expect(shouldOfferPushSetup({ ...base, alreadyDismissed: true })).toBe(false);
  });

  it("stays quiet where it could not work anyway", () => {
    // In a plain Safari tab iOS has no push at all, so offering is a dead end.
    expect(shouldOfferPushSetup({ ...base, standalone: false })).toBe(false);
    expect(shouldOfferPushSetup({ ...base, supported: false })).toBe(false);
    expect(shouldOfferPushSetup({ ...base, permission: "unavailable" })).toBe(false);
  });
});

describe("isPushBlockedBySettings", () => {
  const blocked = {
    supported: true,
    standalone: true,
    permission: "denied" as NotificationPermission,
    hasRegisteredBefore: true,
  };

  it("spots a device iOS has quietly stopped showing notifications on", () => {
    // The push service still returns 201 and the subscription still looks
    // valid, so nothing else in the system can tell.
    expect(isPushBlockedBySettings(blocked)).toBe(true);
  });

  it("does not nag someone who simply said no at the start", () => {
    // Never registered means the denial was a choice, not a revocation.
    expect(isPushBlockedBySettings({ ...blocked, hasRegisteredBefore: false })).toBe(false);
  });

  it("stays quiet when permission is fine or unanswered", () => {
    expect(isPushBlockedBySettings({ ...blocked, permission: "granted" })).toBe(false);
    expect(isPushBlockedBySettings({ ...blocked, permission: "default" })).toBe(false);
  });

  it("stays quiet where push could not work anyway", () => {
    expect(isPushBlockedBySettings({ ...blocked, standalone: false })).toBe(false);
    expect(isPushBlockedBySettings({ ...blocked, supported: false })).toBe(false);
  });
});
