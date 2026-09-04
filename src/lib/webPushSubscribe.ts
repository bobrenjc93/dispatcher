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
import {
  describePushSubscription,
  isValidApplicationServerKey,
  toBase64Url,
  type PushSubscriptionRecord,
} from "./webPushKeys";

/** A subscription plus the key the desktop must sign with to use it. */
export interface PushRegistration extends PushSubscriptionRecord {
  /** Private half of this device's application server key, as a JWK. */
  applicationServerPrivateKey: JsonWebKey;
  applicationServerPublicKey: string;
}

export type PushEnableResult =
  | { ok: true; registration: PushRegistration }
  | { ok: false; reason: string };

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
  if (!isPushSupported()) {
    return {
      ok: false,
      reason: isStandaloneWebApp()
        ? "This browser does not support push notifications."
        : "Add Dispatcher to your Home Screen first — iOS only allows push there.",
    };
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return { ok: false, reason: `Notification permission was ${permission}.` };
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
    return { ok: false, reason: "Generated an application server key of the wrong shape." };
  }

  const subscription = await registration.pushManager.subscribe({
    // Required by every browser, and by iOS in particular: a subscription
    // without it cannot be created at all.
    userVisibleOnly: true,
    applicationServerKey: publicKey,
  });

  const record = describePushSubscription(subscription, getClientId(), Date.now());
  if (!record) {
    return { ok: false, reason: "The browser returned a subscription with no keys." };
  }

  const result: PushRegistration = {
    ...record,
    applicationServerPrivateKey: privateJwk,
    applicationServerPublicKey: toBase64Url(publicKeyBytes),
  };

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
