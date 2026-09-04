/**
 * VAPID key material and the encodings the Push API insists on.
 *
 * Two different base64 dialects meet here and mixing them silently produces a
 * subscription the push service rejects much later, so both directions are
 * kept in one place with tests.
 *
 * The application server key identifies Dispatcher to the push service. The
 * pair is generated once on the desktop and outlives every subscription made
 * against it: change it and every phone already subscribed goes quiet, because
 * a subscription is bound to the key that created it.
 */

/**
 * base64url, unpadded — what the Push API and VAPID both speak, and what
 * `btoa` does not produce.
 */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/")
    + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * `applicationServerKey` must be the raw uncompressed P-256 point: 65 bytes
 * beginning with 0x04. A JWK or SPKI encoding is the easy mistake and the
 * browser rejects it with a message that does not say which of the two it
 * wanted, so the shape is asserted here rather than at subscribe time.
 */
export function isValidApplicationServerKey(bytes: Uint8Array): boolean {
  return bytes.length === 65 && bytes[0] === 0x04;
}

/** What the desktop stores about one subscribed device. */
export interface PushSubscriptionRecord {
  endpoint: string;
  /** The client's public key, for encrypting to it. */
  p256dh: string;
  /** The client's auth secret. */
  auth: string;
  /** Which client sent it, so a re-subscribe replaces rather than duplicates. */
  clientId: string;
  createdAt: number;
}

/**
 * Flatten a browser `PushSubscription` into something that survives being sent
 * over the wire and written to disk.
 *
 * `PushSubscription.toJSON()` exists but its `keys` are optional in the type
 * and absent in some browsers, and a record missing either key cannot be
 * encrypted to — so the absence is reported here rather than becoming a push
 * that silently fails much later.
 */
export function describePushSubscription(
  subscription: { endpoint: string; toJSON: () => { keys?: Record<string, string> } },
  clientId: string,
  now: number
): PushSubscriptionRecord | null {
  const keys = subscription.toJSON().keys ?? {};
  const p256dh = keys.p256dh;
  const auth = keys.auth;
  if (!subscription.endpoint || !p256dh || !auth) {
    return null;
  }
  return { endpoint: subscription.endpoint, p256dh, auth, clientId, createdAt: now };
}

/**
 * Replace any earlier record from the same client, keep the rest.
 *
 * Keyed on client rather than endpoint: a phone that re-subscribes gets a new
 * endpoint, and matching on endpoint would leave the dead one behind to be
 * pushed to forever.
 */
export function mergeSubscription(
  existing: readonly PushSubscriptionRecord[],
  next: PushSubscriptionRecord
): PushSubscriptionRecord[] {
  return [...existing.filter((entry) => entry.clientId !== next.clientId), next];
}

/** What a device remembers so it can re-offer the same subscription later. */
export interface StoredDeviceKey {
  endpoint: string;
  privateJwk: JsonWebKey;
  publicKey: string;
}

/**
 * Whether a stored key still describes the subscription the browser holds.
 *
 * Re-subscribing mints a new endpoint and a new keypair, so doing it on every
 * load would churn through push-service registrations for no reason. But a
 * stored key only helps if it belongs to the subscription that actually
 * exists: iOS can retire a subscription on its own, and signing for the wrong
 * endpoint fails at the push service long after the cause.
 */
export function canReuseStoredKey(
  stored: StoredDeviceKey | null,
  currentEndpoint: string | null
): boolean {
  return Boolean(stored && currentEndpoint && stored.endpoint === currentEndpoint);
}
