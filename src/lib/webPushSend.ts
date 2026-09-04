/**
 * Sending a Web Push message, from the desktop.
 *
 * Two independent pieces of cryptography, both mandatory:
 *
 * - **VAPID** (RFC 8292) authenticates Dispatcher to the push service. A
 *   signed JWT in the `Authorization` header, or the service refuses.
 * - **aes128gcm** (RFC 8291) encrypts the payload to the subscriber. The push
 *   service relays ciphertext it cannot read; only the phone holds the key.
 *
 * Done here in the renderer rather than in Rust because the desktop already
 * runs the logic that decides a tab needs attention, and Web Crypto has
 * everything required. It also means no new native dependency, so this ships
 * without a rebuild.
 */

import { invoke } from "@tauri-apps/api/core";
import { fromBase64Url, toBase64Url } from "./webPushKeys";

/** How long the push service should hold a message for a phone that is off. */
const DEFAULT_TTL_SECONDS = 6 * 60 * 60;

/**
 * Record size from RFC 8188. Only one record is ever sent — the payloads here
 * are a title and a line of text — so this is a declared ceiling rather than a
 * chunking decision.
 */
const RECORD_SIZE = 4096;

const encoder = new TextEncoder();

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** HKDF as RFC 8291 uses it: one extract, then one 1-block expand. */
async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number
): Promise<Uint8Array> {
  const saltKey = await crypto.subtle.importKey("raw", toArrayBuffer(salt), "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: toArrayBuffer(salt), info: toArrayBuffer(info) },
    await crypto.subtle.importKey("raw", toArrayBuffer(ikm), "HKDF", false, ["deriveBits"]),
    length * 8
  );
  void saltKey;
  return new Uint8Array(bits);
}

/**
 * A standalone ArrayBuffer for a view.
 *
 * Web Crypto rejects a `Uint8Array` whose backing buffer is shared or larger
 * than the view, and subarrays of a concatenation are exactly that.
 */
function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(view.byteLength);
  new Uint8Array(copy).set(view);
  return copy;
}

/**
 * The content key and nonce for one message, from RFC 8291 §3.3.
 *
 * Exported so each derivation step can be checked against the worked example
 * in the RFC. Verifying the finished body only tells you something is wrong;
 * verifying these tells you which step.
 */
export async function derivePushContentKeys(args: {
  authSecret: Uint8Array;
  sharedSecret: Uint8Array;
  clientPublicKey: Uint8Array;
  serverPublicKey: Uint8Array;
  salt: Uint8Array;
}): Promise<{ ikm: Uint8Array; cek: Uint8Array; nonce: Uint8Array }> {
  // The order of the two public keys is fixed: subscriber first, sender
  // second. Swapping them yields a key that decrypts to garbage on the phone
  // with no error anywhere along the way.
  const keyInfo = concat(
    encoder.encode("WebPush: info\0"),
    args.clientPublicKey,
    args.serverPublicKey
  );
  const ikm = await hkdf(args.authSecret, args.sharedSecret, keyInfo, 32);
  const cek = await hkdf(args.salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(args.salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);
  return { ikm, cek, nonce };
}

export interface EncryptedPush {
  body: Uint8Array;
  /** Ephemeral public key, needed by callers that log or test. */
  serverPublicKey: Uint8Array;
}

/**
 * Encrypt a payload to a subscriber, per RFC 8291.
 *
 * `salt` and `serverKeys` are injectable so the RFC's own test vector can be
 * reproduced exactly; production passes neither and gets fresh randomness.
 */
export async function encryptPushPayload(args: {
  payload: Uint8Array;
  /** Subscriber's public key (`p256dh`), raw uncompressed point. */
  clientPublicKey: Uint8Array;
  /** Subscriber's `auth` secret, 16 bytes. */
  authSecret: Uint8Array;
  salt?: Uint8Array;
  serverKeys?: CryptoKeyPair;
}): Promise<EncryptedPush> {
  const salt = args.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const serverKeys =
    args.serverKeys
    ?? (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ]));

  const serverPublicKey = new Uint8Array(
    await crypto.subtle.exportKey("raw", serverKeys.publicKey)
  );

  const clientKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(args.clientPublicKey),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: clientKey },
      serverKeys.privateKey,
      256
    )
  );

  const { cek, nonce } = await derivePushContentKeys({
    authSecret: args.authSecret,
    sharedSecret,
    clientPublicKey: args.clientPublicKey,
    serverPublicKey,
    salt,
  });

  const aesKey = await crypto.subtle.importKey("raw", toArrayBuffer(cek), "AES-GCM", false, [
    "encrypt",
  ]);
  // 0x02 is the last-record delimiter from RFC 8188; without it the phone
  // rejects the record as truncated.
  const plaintext = concat(args.payload, new Uint8Array([0x02]));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: toArrayBuffer(nonce), tagLength: 128 },
      aesKey,
      toArrayBuffer(plaintext)
    )
  );

  const header = new Uint8Array(5);
  new DataView(header.buffer).setUint32(0, RECORD_SIZE);
  header[4] = serverPublicKey.length;

  return { body: concat(salt, header, serverPublicKey, ciphertext), serverPublicKey };
}

/**
 * The VAPID `Authorization` header value.
 *
 * `aud` is the push service's origin, not the endpoint path — a full endpoint
 * there is rejected, and the rejection does not say why.
 */
export async function buildVapidAuthorization(args: {
  endpoint: string;
  privateJwk: JsonWebKey;
  publicKey: string;
  subject: string;
  now: number;
  ttlSeconds?: number;
}): Promise<string> {
  const audience = new URL(args.endpoint).origin;
  const header = toBase64Url(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = toBase64Url(
    encoder.encode(
      JSON.stringify({
        aud: audience,
        exp: Math.floor(args.now / 1000) + (args.ttlSeconds ?? 12 * 60 * 60),
        sub: args.subject,
      })
    )
  );
  const signingInput = `${header}.${claims}`;

  const key = await crypto.subtle.importKey(
    "jwk",
    args.privateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  // Web Crypto emits the raw r||s pair ES256 wants. A DER-wrapped signature —
  // what most non-browser libraries produce by default — is rejected.
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      toArrayBuffer(encoder.encode(signingInput))
    )
  );

  return `vapid t=${signingInput}.${toBase64Url(signature)}, k=${args.publicKey}`;
}

export type PushSendResult =
  | { ok: true; status: number }
  | { ok: false; status: number; expired: boolean; detail: string };

/**
 * Deliver one notification.
 *
 * `expired` distinguishes the one failure worth acting on: 404 and 410 are how
 * a push service says the subscription is gone for good — the web app was
 * uninstalled, or permission revoked — and retrying those is what gets a
 * sender throttled. Everything else is transient and the next attention event
 * will try again anyway.
 */
export async function sendPushNotification(args: {
  endpoint: string;
  p256dh: string;
  auth: string;
  privateJwk: JsonWebKey;
  publicKey: string;
  subject: string;
  payload: unknown;
  now: number;
  ttlSeconds?: number;
}): Promise<PushSendResult> {
  const { body } = await encryptPushPayload({
    payload: encoder.encode(JSON.stringify(args.payload)),
    clientPublicKey: fromBase64Url(args.p256dh),
    authSecret: fromBase64Url(args.auth),
  });

  const authorization = await buildVapidAuthorization({
    endpoint: args.endpoint,
    privateJwk: args.privateJwk,
    publicKey: args.publicKey,
    subject: args.subject,
    now: args.now,
  });

  // Sent from the native side, not with fetch. A push service has no reason
  // to support CORS — it exists to be called by servers — and Apple's returns
  // no `Access-Control-*` headers, so the preflight for these headers fails
  // before the request is made. The error a browser reports for that is a bare
  // "Load failed" with no status, which is exactly what this looked like.
  let response: { status: number; detail: string };
  try {
    response = await invoke<{ status: number; detail: string }>("send_web_push", {
      endpoint: args.endpoint,
      authorization,
      ttlSeconds: args.ttlSeconds ?? DEFAULT_TTL_SECONDS,
      body: Array.from(body),
    });
  } catch (error) {
    return {
      ok: false,
      status: 0,
      expired: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  if (response.status >= 200 && response.status < 300) {
    return { ok: true, status: response.status };
  }
  return {
    ok: false,
    status: response.status,
    expired: response.status === 404 || response.status === 410,
    detail: response.detail,
  };
}
