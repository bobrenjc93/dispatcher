import { describe, expect, it } from "vitest";
import {
  describePushSubscription,
  fromBase64Url,
  isValidApplicationServerKey,
  mergeSubscription,
  toBase64Url,
  type PushSubscriptionRecord,
} from "../webPushKeys";

describe("base64url", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array(256).map((_, i) => i);
    expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
  });

  it("emits the url alphabet with no padding", () => {
    // These bytes produce '+' and '/' under standard base64, which the Push
    // API rejects; the padding it also rejects.
    const encoded = toBase64Url(new Uint8Array([0xfb, 0xef, 0xbe]));
    expect(encoded).not.toMatch(/[+/=]/);
    expect(fromBase64Url(encoded)).toEqual(new Uint8Array([0xfb, 0xef, 0xbe]));
  });

  it("decodes input that arrives padded or in the standard alphabet", () => {
    // A key pasted from elsewhere may well be either.
    expect(fromBase64Url("++__")).toEqual(fromBase64Url("--__"));
    expect(fromBase64Url("YQ==")).toEqual(new Uint8Array([0x61]));
    expect(fromBase64Url("YQ")).toEqual(new Uint8Array([0x61]));
  });
});

describe("isValidApplicationServerKey", () => {
  it("accepts a raw uncompressed P-256 point", () => {
    const key = new Uint8Array(65);
    key[0] = 0x04;
    expect(isValidApplicationServerKey(key)).toBe(true);
  });

  it("rejects the encodings that are easy to pass by mistake", () => {
    // A compressed point, and something SPKI-sized: both are what you get if
    // the key was exported the obvious-but-wrong way.
    const compressed = new Uint8Array(33);
    compressed[0] = 0x02;
    expect(isValidApplicationServerKey(compressed)).toBe(false);
    expect(isValidApplicationServerKey(new Uint8Array(91))).toBe(false);
    const wrongPrefix = new Uint8Array(65);
    wrongPrefix[0] = 0x30;
    expect(isValidApplicationServerKey(wrongPrefix)).toBe(false);
  });
});

describe("describePushSubscription", () => {
  const sub = (keys?: Record<string, string>, endpoint = "https://web.push.apple.com/abc") => ({
    endpoint,
    toJSON: () => ({ keys }),
  });

  it("flattens a usable subscription", () => {
    const record = describePushSubscription(
      sub({ p256dh: "PUB", auth: "AUTH" }),
      "client-1",
      1234
    );
    expect(record).toEqual({
      endpoint: "https://web.push.apple.com/abc",
      p256dh: "PUB",
      auth: "AUTH",
      clientId: "client-1",
      createdAt: 1234,
    });
  });

  it("reports a subscription that cannot be encrypted to", () => {
    // Without both keys there is no way to encrypt a payload, and storing it
    // would turn into a push that fails long after the cause.
    expect(describePushSubscription(sub(undefined), "c", 1)).toBeNull();
    expect(describePushSubscription(sub({ p256dh: "PUB" }), "c", 1)).toBeNull();
    expect(describePushSubscription(sub({ auth: "AUTH" }), "c", 1)).toBeNull();
    expect(describePushSubscription(sub({ p256dh: "P", auth: "A" }, ""), "c", 1)).toBeNull();
  });
});

describe("mergeSubscription", () => {
  const record = (clientId: string, endpoint: string): PushSubscriptionRecord => ({
    endpoint,
    p256dh: "P",
    auth: "A",
    clientId,
    createdAt: 0,
  });

  it("replaces a client's earlier subscription rather than accumulating", () => {
    // Re-subscribing yields a new endpoint; keying on endpoint would leave the
    // dead one behind to be pushed to forever.
    const existing = [record("phone", "https://old"), record("laptop", "https://l")];
    const merged = mergeSubscription(existing, record("phone", "https://new"));
    expect(merged.map((r) => r.endpoint).sort()).toEqual(["https://l", "https://new"]);
  });

  it("keeps other devices", () => {
    const merged = mergeSubscription([record("a", "https://a")], record("b", "https://b"));
    expect(merged).toHaveLength(2);
  });
});
