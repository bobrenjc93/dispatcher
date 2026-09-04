/**
 * Getting a phone subscribed to push, from the phone's side.
 *
 * The delivery path never touches Tailscale: the desktop makes an outbound
 * HTTPS request to the push service (Apple's, for an iOS home-screen web app)
 * and the push service reaches the phone. That is what lets a notification
 * arrive when the web app is closed and the mirror socket is long dead, which
 * the chime and the dock bounce cannot do.
 *
 * ## Why the phone generates the application server key
 *
 * A subscription is bound to the `applicationServerKey` used to create it, and
 * the desktop must sign with the matching private half when it pushes. The
 * obvious arrangement — desktop owns one keypair, hands the public half out —
 * needs a desktop-to-replica config channel, and there isn't one: the mirror
 * channel carries per-terminal frames and the shared snapshot is the workspace
 * document, which this is not part of.
 *
 * So each device makes its own pair and sends the private half up with the
 * subscription. Per-device keys are allowed — the key identifies the sender to
 * the push service for that one subscription, not the user — and this key
 * travels the same socket that already carries every terminal's contents. An
 * attacker holding it could push notifications to one phone; the same access
 * already reveals everything on screen, so it does not widen the exposure.
 */

import { getClientId } from "./clientId";
import { debugLog } from "./debugLog";
import { getScopedStorageKey } from "./storageNamespace";
import {
  canReuseStoredKey,
  describePushSubscription,
  isValidApplicationServerKey,
  toBase64Url,
  type PushSubscriptionRecord,
  type StoredDeviceKey,
} from "./webPushKeys";

/**
 * This device's half of its application server key.
 *
 * Kept so a later load can re-offer the subscription it already has instead of
 * minting a new one: the private half lives on the desktop, so without a local
 * copy the only way to tell the desktop about an existing subscription would
 * be to throw it away and make another.
 */
const DEVICE_KEY_STORAGE = getScopedStorageKey("dispatcher.pushDeviceKey");
const DEVICE_ID_STORAGE = getScopedStorageKey("dispatcher.pushDeviceId");

/**
 * A stable identity for this device, distinct from the session client id.
 *
 * `getClientId` lives in sessionStorage and is reissued every launch, which is
 * right for a mirror client and wrong here: the desktop dedupes subscriptions
 * by this id, so a fresh one each time turns one phone into a growing list of
 * devices, each getting its own copy of every notification.
 */
export function getPushDeviceId(): string {
  try {
    const stored = window.localStorage.getItem(DEVICE_ID_STORAGE);
    if (stored) {
      return stored;
    }
    const next = `push-${crypto.randomUUID()}`;
    window.localStorage.setItem(DEVICE_ID_STORAGE, next);
    return next;
  } catch {
    // Without storage the id cannot be stable; falling back to the session id
    // keeps this working, at the cost of the duplication described above.
    return getClientId();
  }
}

function readStoredDeviceKey(): StoredDeviceKey | null {
  try {
    const raw = window.localStorage.getItem(DEVICE_KEY_STORAGE);
    return raw ? (JSON.parse(raw) as StoredDeviceKey) : null;
  } catch {
    return null;
  }
}

function writeStoredDeviceKey(value: StoredDeviceKey) {
  try {
    window.localStorage.setItem(DEVICE_KEY_STORAGE, JSON.stringify(value));
  } catch {
    // Losing this costs one extra re-subscribe, not correctness.
  }
}

/** A subscription plus the key the desktop must sign with to use it. */
export interface PushRegistration extends PushSubscriptionRecord {
  /** Private half of this device's application server key, as a JWK. */
  applicationServerPrivateKey: JsonWebKey;
  applicationServerPublicKey: string;
  /**
   * True when the user just turned this on, rather than the app renewing an
   * existing subscription on load.
   *
   * The desktop answers an explicit enable with a confirmation notification:
   * it is the only way to find out the whole chain works, and finding out
   * later — by not being notified about something — is no use at all. Renewals
   * are silent, or every launch would ping the phone.
   */
  confirm?: boolean;
}

export type PushEnableResult =
  | { ok: true; registration: PushRegistration }
  | { ok: false; reason: string };

/**
 * Every refusal is logged, not just returned.
 *
 * The reason reaches the user as a toast on the phone and nowhere else, which
 * makes a failed attempt invisible from the desktop — indistinguishable from
 * never having tapped the button.
 */
function refuse(reason: string, detail: Record<string, unknown> = {}): PushEnableResult {
  debugLog("push", "could not enable push", { reason, ...detail });
  return { ok: false, reason };
}

/**
 * Whether this browser can do push at all.
 *
 * On iOS every one of these is present only inside a web app that has been
 * added to the Home Screen; in a normal Safari tab `PushManager` is missing
 * however many times the user grants permission.
 */
export function isPushSupported(): boolean {
  return (
    typeof window !== "undefined"
    && "serviceWorker" in navigator
    && "PushManager" in window
    && "Notification" in window
  );
}

/**
 * iOS reports this false for a tab and true only once the app is launched from
 * the Home Screen, which is the distinction that decides whether push can work
 * at all — worth telling the user apart from a plain refusal.
 */
export function isStandaloneWebApp(): boolean {
  if (typeof window === "undefined") return false;
  const iosStandalone = (window.navigator as { standalone?: boolean }).standalone;
  return Boolean(iosStandalone) || window.matchMedia("(display-mode: standalone)").matches;
}

async function generateApplicationServerKey(): Promise<{
  publicKey: ArrayBuffer;
  privateJwk: JsonWebKey;
}> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
  // "raw" is the uncompressed point the Push API wants; exporting as spki or
  // jwk here is the classic mistake and subscribe() rejects it opaquely. The
  // ArrayBuffer is passed through untouched because `subscribe` wants a
  // BufferSource, and a view over it does not satisfy that in strict mode.
  const publicKey = await crypto.subtle.exportKey("raw", pair.publicKey);
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { publicKey, privateJwk };
}

/**
 * Ask for permission and subscribe. Must be called from a user gesture: Safari
 * refuses the permission prompt otherwise, and reports the refusal as a plain
 * denial that looks identical to the user having said no.
 */
export async function enablePushNotifications(): Promise<PushEnableResult> {
  debugLog("push", "enable push requested", {
    supported: isPushSupported(),
    standalone: isStandaloneWebApp(),
    permission: typeof Notification === "undefined" ? "unavailable" : Notification.permission,
  });

  if (!isPushSupported()) {
    return refuse(
      isStandaloneWebApp()
        ? "This browser does not support push notifications."
        : "Add Dispatcher to your Home Screen first — iOS only allows push there.",
      {
        serviceWorker: "serviceWorker" in navigator,
        pushManager: typeof window !== "undefined" && "PushManager" in window,
        notification: typeof window !== "undefined" && "Notification" in window,
      }
    );
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return refuse(`Notification permission was ${permission}.`);
  }

  const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  // A registration that is installing cannot be subscribed against yet.
  await navigator.serviceWorker.ready;

  const existing = await registration.pushManager.getSubscription();
  if (existing) {
    // The old subscription is bound to a key we may no longer hold, and there
    // is no way to recover it — so start clean rather than keep something that
    // cannot be pushed to.
    await existing.unsubscribe().catch(() => {});
  }

  const { publicKey, privateJwk } = await generateApplicationServerKey();
  const publicKeyBytes = new Uint8Array(publicKey);
  if (!isValidApplicationServerKey(publicKeyBytes)) {
    return refuse("Generated an application server key of the wrong shape.", {
      length: publicKeyBytes.length,
    });
  }

  const subscription = await registration.pushManager.subscribe({
    // Required by every browser, and by iOS in particular: a subscription
    // without it cannot be created at all.
    userVisibleOnly: true,
    applicationServerKey: publicKey,
  });

  const record = describePushSubscription(subscription, getPushDeviceId(), Date.now());
  if (!record) {
    return refuse("The browser returned a subscription with no keys.", {
      endpointHost: safeEndpointHost(subscription.endpoint),
    });
  }

  const result: PushRegistration = {
    ...record,
    applicationServerPrivateKey: privateJwk,
    applicationServerPublicKey: toBase64Url(publicKeyBytes),
  };
  writeStoredDeviceKey({
    endpoint: result.endpoint,
    privateJwk,
    publicKey: result.applicationServerPublicKey,
  });

  result.confirm = true;
  debugLog("push", "replica subscribed", {
    clientId: result.clientId,
    endpointHost: safeEndpointHost(result.endpoint),
    standalone: isStandaloneWebApp(),
  });

  return { ok: true, registration: result };
}

/**
 * Just the host of a push endpoint. The full URL is a bearer capability to
 * notify this device, so it does not belong in a log file.
 */
export function safeEndpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return "<unparseable>";
  }
}

/**
 * Re-offer an existing subscription, without prompting.
 *
 * The permission prompt needs a user gesture, but everything after it does
 * not. Once permission is granted the tap has done its job forever, so this
 * runs on load and keeps the desktop's record current — which matters because
 * the desktop drops endpoints the push service reports as gone, and because a
 * subscription iOS quietly retired would otherwise stay broken until someone
 * noticed the notifications had stopped.
 *
 * Returns null when there is nothing to do, which is the common case: no
 * permission yet, or not a browser that can do this at all.
 */
export async function restorePushRegistration(): Promise<PushRegistration | null> {
  if (!isPushSupported() || Notification.permission !== "granted") {
    return null;
  }

  const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;

  const existing = await registration.pushManager.getSubscription();
  const stored = readStoredDeviceKey();

  if (canReuseStoredKey(stored, existing?.endpoint ?? null) && existing && stored) {
    const record = describePushSubscription(existing, getPushDeviceId(), Date.now());
    if (record) {
      debugLog("push", "re-offered an existing subscription", {
        clientId: record.clientId,
        endpointHost: safeEndpointHost(record.endpoint),
      });
      return {
        ...record,
        applicationServerPrivateKey: stored.privateJwk,
        applicationServerPublicKey: stored.publicKey,
      };
    }
  }

  // Permission is already granted, so subscribing afresh prompts for nothing.
  const result = await enablePushNotifications();
  return result.ok ? result.registration : null;
}

/**
 * Whether to offer setup on load.
 *
 * Only when it can actually succeed and has not been answered: asking in a
 * plain Safari tab is a dead end, and asking again after a refusal is worse
 * than useless because a denial is permanent — the prompt cannot be shown a
 * second time, so nagging just wastes the one chance the user has to say yes
 * from Settings instead.
 */
export function shouldOfferPushSetup(args: {
  supported: boolean;
  standalone: boolean;
  permission: NotificationPermission | "unavailable";
  alreadyDismissed: boolean;
}): boolean {
  return (
    args.supported
    && args.standalone
    && args.permission === "default"
    && !args.alreadyDismissed
  );
}
