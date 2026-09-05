/**
 * Sending an attention event to every phone that asked for one.
 *
 * Its own switch, per tab, rather than something implied by the chime or the
 * dock bounce. Those two reach someone sitting at the machine; this reaches a
 * phone anywhere, so the set of tabs worth it is genuinely different — plenty
 * deserve a noise on the desktop and none of your attention when you are out.
 *
 * What it does share is *when*: the same inactivity threshold, acknowledgement
 * and focus rules that gate the chime, which were tuned at length and should
 * not be second-guessed here.
 */

import { debugLog } from "./debugLog";
import { forgetPushSubscription, listPushSubscriptions } from "./pushRegistry";
import { sendPushNotification } from "./webPushSend";
import { safeEndpointHost } from "./webPushSubscribe";

/**
 * VAPID requires a contact the push service can use if a sender misbehaves.
 *
 * Apple validates it: `mailto:dispatcher@localhost` is syntactically a mailto
 * but `localhost` resolves to nothing, and the whole token comes back as
 * `403 BadJwtToken` — an error that says nothing about which claim was wrong.
 * An https URL identifying the software is equally valid and cannot go stale
 * the way a personal address would.
 */
const VAPID_SUBJECT = "https://github.com/bobrenjc93/dispatcher";

/** Text of the notification, kept to what is useful on a lock screen. */
export function buildPushPayload(args: { title: string; terminalId: string }) {
  return {
    title: args.title || "Dispatcher",
    body: "Quiet for a while — it may be waiting on you.",
    terminalId: args.terminalId,
  };
}

/**
 * Push to every registered device.
 *
 * Failures are logged and otherwise swallowed: this is a courtesy on top of
 * two notifications that already fired locally, and a push service being slow
 * or unreachable must not disturb the status monitor that called it.
 */
export async function pushAttentionNotification(args: {
  tabRootTerminalId: string;
  title: string;
  now: number;
}): Promise<void> {
  const devices = listPushSubscriptions();
  if (devices.length === 0) {
    return;
  }

  const payload = buildPushPayload({
    title: args.title,
    terminalId: args.tabRootTerminalId,
  });

  await Promise.all(
    devices.map(async (device) => {
      const result = await sendPushNotification({
        endpoint: device.endpoint,
        p256dh: device.p256dh,
        auth: device.auth,
        privateJwk: device.applicationServerPrivateKey,
        publicKey: device.applicationServerPublicKey,
        subject: VAPID_SUBJECT,
        payload,
        now: args.now,
      });

      if (result.ok) {
        debugLog("push", "sent a notification", {
          endpointHost: safeEndpointHost(device.endpoint),
          tabRootTerminalId: args.tabRootTerminalId,
          status: result.status,
        });
        return;
      }

      debugLog("push", "push failed", {
        endpointHost: safeEndpointHost(device.endpoint),
        status: result.status,
        expired: result.expired,
        detail: result.detail.slice(0, 200),
      });

      if (result.expired) {
        // The web app was uninstalled or permission revoked. Retrying this
        // forever is what gets a sender throttled by the push service.
        forgetPushSubscription(device.endpoint);
      }
    })
  );
}

/**
 * Acknowledge a device that just enabled notifications, by notifying it.
 *
 * The only honest test of a push pipeline is a push arriving. Everything up to
 * this point can look right — permission granted, subscription stored, keys
 * the correct shape — while the message still fails to decrypt on the phone,
 * and that failure is silent at every layer.
 */
export async function confirmPushRegistration(args: {
  endpoint: string;
  p256dh: string;
  auth: string;
  privateJwk: JsonWebKey;
  publicKey: string;
  now: number;
}): Promise<void> {
  const result = await sendPushNotification({
    endpoint: args.endpoint,
    p256dh: args.p256dh,
    auth: args.auth,
    privateJwk: args.privateJwk,
    publicKey: args.publicKey,
    subject: VAPID_SUBJECT,
    payload: {
      title: "Dispatcher",
      body: "Notifications are on for this device.",
    },
    now: args.now,
  });

  debugLog("push", result.ok ? "confirmation sent" : "confirmation failed", {
    endpointHost: safeEndpointHost(args.endpoint),
    status: result.status,
    ...(result.ok ? {} : { detail: result.detail.slice(0, 300) }),
  });
}
