import { describe, expect, it } from "vitest";
import {
  buildVapidAuthorization,
  derivePushContentKeys,
  encryptPushPayload,
} from "../webPushSend";
import { fromBase64Url, toBase64Url } from "../webPushKeys";

/**
 * RFC 8291 §5 publishes a complete worked example. Reproducing its exact
 * output is the only way to know this is right: every mistake available here —
 * swapping the two public keys in key_info, dropping the 0x02 delimiter,
 * mis-ordering the header — produces a well-formed body that decrypts to
 * nothing on the phone, with no error at any point in between.
 */
/**
 * RFC 8291 §5 and Appendix A publish a complete worked example, including the
 * intermediate values. Checking those rather than only the finished body is
 * what makes a failure diagnosable: every mistake available here — swapping
 * the two public keys in key_info, the wrong info string, a bad salt — yields
 * a well-formed message that decrypts to nothing on the phone, with no error
 * at any point in between.
 */
const VECTOR = {
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
  receiverPublic:
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcx"
    + "aOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  senderPublic:
    "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIg"
    + "Dll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  ecdhSecret: "kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs",
  ikm: "S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg",
  cek: "oIhVW04MRdy2XN9CiKLxTg",
  nonce: "4h_95klXJ5E_qnoN",
};

describe("derivePushContentKeys", () => {
  it("matches the RFC 8291 worked example at every step", async () => {
    const { ikm, cek, nonce } = await derivePushContentKeys({
      authSecret: fromBase64Url(VECTOR.authSecret),
      sharedSecret: fromBase64Url(VECTOR.ecdhSecret),
      clientPublicKey: fromBase64Url(VECTOR.receiverPublic),
      serverPublicKey: fromBase64Url(VECTOR.senderPublic),
      salt: fromBase64Url(VECTOR.salt),
    });

    expect(toBase64Url(ikm)).toBe(VECTOR.ikm);
    expect(toBase64Url(cek)).toBe(VECTOR.cek);
    expect(toBase64Url(nonce)).toBe(VECTOR.nonce);
  });

  it("derives a different key if the two public keys are swapped", async () => {
    // The failure this guards is silent: the message still sends, the push
    // service still accepts it, and the phone shows nothing.
    const swapped = await derivePushContentKeys({
      authSecret: fromBase64Url(VECTOR.authSecret),
      sharedSecret: fromBase64Url(VECTOR.ecdhSecret),
      clientPublicKey: fromBase64Url(VECTOR.senderPublic),
      serverPublicKey: fromBase64Url(VECTOR.receiverPublic),
      salt: fromBase64Url(VECTOR.salt),
    });
    expect(toBase64Url(swapped.cek)).not.toBe(VECTOR.cek);
  });
});

describe("encryptPushPayload", () => {
  it("produces a body with the RFC 8188 header shape", async () => {
    const receiver = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"]
    );
    const clientPublicKey = new Uint8Array(
      await crypto.subtle.exportKey("raw", receiver.publicKey)
    );
    const { body } = await encryptPushPayload({
      payload: new TextEncoder().encode("hi"),
      clientPublicKey,
      authSecret: crypto.getRandomValues(new Uint8Array(16)),
    });

    // salt(16) | record size(4) | key length(1) | key(65) | ciphertext
    expect(body.length).toBeGreaterThan(16 + 4 + 1 + 65);
    expect(body[20]).toBe(65);
    expect(new DataView(body.buffer, body.byteOffset).getUint32(16)).toBe(4096);
    expect(body[21]).toBe(0x04);
  });

  it("uses fresh randomness for every message", async () => {
    const receiver = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"]
    );
    const clientPublicKey = new Uint8Array(
      await crypto.subtle.exportKey("raw", receiver.publicKey)
    );
    const auth = crypto.getRandomValues(new Uint8Array(16));
    const payload = new TextEncoder().encode("same text");

    const a = await encryptPushPayload({ payload, clientPublicKey, authSecret: auth });
    const b = await encryptPushPayload({ payload, clientPublicKey, authSecret: auth });
    expect(toBase64Url(a.body)).not.toBe(toBase64Url(b.body));
  });
});

describe("buildVapidAuthorization", () => {
  it("addresses the push service's origin, not the endpoint", async () => {
    const keys = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"]
    );
    const header = await buildVapidAuthorization({
      endpoint: "https://web.push.apple.com/QRS/very/long/path?x=1",
      privateJwk: await crypto.subtle.exportKey("jwk", keys.privateKey),
      publicKey: "PUBKEY",
      subject: "mailto:dispatcher@localhost",
      now: 1_700_000_000_000,
    });

    const [, token] = /^vapid t=([^,]+), k=PUBKEY$/.exec(header) ?? [];
    expect(token).toBeTruthy();
    const [, claims, signature] = token.split(".");
    const decoded = JSON.parse(new TextDecoder().decode(fromBase64Url(claims)));
    // A full endpoint here is rejected by the push service, unhelpfully.
    expect(decoded.aud).toBe("https://web.push.apple.com");
    expect(decoded.sub).toBe("mailto:dispatcher@localhost");
    expect(decoded.exp).toBe(1_700_000_000 + 12 * 60 * 60);
    // ES256 wants the raw r||s pair; a DER signature would be longer.
    expect(fromBase64Url(signature).length).toBe(64);
  });
});
