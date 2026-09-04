/**
 * The desktop's list of devices to notify.
 *
 * Held on the desktop because it is the only party that can reach a push
 * service: a replica cannot notify itself once its web app is closed, which is
 * the only moment any of this matters.
 *
 * Stored locally rather than in the workspace document. A subscription
 * describes one device's relationship with one push service — it is not part
 * of the workspace, it must not travel to other replicas, and it would be
 * actively harmful in a document that gets exported and restored.
 */

import { debugLog } from "./debugLog";
import { getScopedStorageKey } from "./storageNamespace";
import { mergeSubscription } from "./webPushKeys";
import { safeEndpointHost, type PushRegistration } from "./webPushSubscribe";

const STORAGE_KEY = getScopedStorageKey("dispatcher.pushSubscriptions");

function read(): PushRegistration[] {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // A corrupt entry must not take the app down at startup; losing the
    // subscriptions costs one re-enable per device.
    return [];
  }
}

function write(entries: PushRegistration[]) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch (error) {
    debugLog("push", "failed to persist push subscriptions", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function listPushSubscriptions(): PushRegistration[] {
  return read();
}

/** Record a device, replacing any earlier registration from the same client. */
export function rememberPushSubscription(registration: PushRegistration) {
  const next = mergeSubscription(read(), registration) as PushRegistration[];
  write(next);
  debugLog("push", "registered a device for push", {
    clientId: registration.clientId,
    // The endpoint URL is a bearer capability to notify the device, so only
    // its host goes in the log.
    endpointHost: safeEndpointHost(registration.endpoint),
    devices: next.length,
  });
}

/**
 * Drop a device. Called when a push service reports the subscription gone —
 * 404 and 410 are how it says the user uninstalled the web app or revoked
 * permission, and retrying those forever is what gets a sender throttled.
 */
export function forgetPushSubscription(endpoint: string) {
  const before = read();
  const next = before.filter((entry) => entry.endpoint !== endpoint);
  if (next.length === before.length) {
    return;
  }
  write(next);
  debugLog("push", "dropped an expired push subscription", {
    endpointHost: safeEndpointHost(endpoint),
    devices: next.length,
  });
}
