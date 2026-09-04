/**
 * Sending an attention event to every phone that asked for one.
 *
 * Deliberately not a new decision about when to interrupt someone. The rules
 * for that already exist and were tuned at length — inaction thresholds,
 * acknowledgement, whether Dispatcher is in front of you — so this rides along
 * with the chime and the dock bounce rather than second-guessing them. A tab
 * that would chime or bounce also pushes; a tab that would not, does not.
 *
 * What push adds is reach. The chime needs speakers you can hear and the
 * bounce needs a dock you can see; both are useless once the laptop is shut,
 * which is the case this exists for.
 */

import { debugLog } from "./debugLog";
import { forgetPushSubscription, listPushSubscriptions } from "./pushRegistry";
import { sendPushNotification } from "./webPushSend";
import { safeEndpointHost } from "./webPushSubscribe";

/**
 * VAPID requires a contact the push service can use if a sender misbehaves.
 * It never leaves the desktop except in the signed token, and no mail is ever
 * sent to it — but the header is rejected outright without one.
 */
const VAPID_SUBJECT = "mailto:dispatcher@localhost";

/**
 * Whether a tab has opted into being reached at all.
 *
 * Either switch counts. They differ in *when* they fire, not in whether the
 * user wants to know about this tab, and asking someone to tick a third box
 * that means "and also on my phone" is a distinction without a difference.
 */
export function wantsPushForAttention(args: {
  notifyOnInaction: boolean | undefined;
  bounceOnAttention: boolean | undefined;
}): boolean {
  return Boolean(args.notifyOnInaction) || Boolean(args.bounceOnAttention);
}

/** Text of the notification, kept to what is useful on a lock screen. */
export function buildPushPayload(args: {
  title: string;
  reason: "inaction" | "attention";
  terminalId: string;
}) {
  return {
    title: args.title || "Dispatcher",
    body:
      args.reason === "inaction"
        ? "Quiet for a while — it may be waiting on you."
        : "Needs your attention.",
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
  reason: "inaction" | "attention";
  now: number;
}): Promise<void> {
  const devices = listPushSubscriptions();
  if (devices.length === 0) {
    return;
  }

  const payload = buildPushPayload({
    title: args.title,
    reason: args.reason,
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
          reason: args.reason,
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
