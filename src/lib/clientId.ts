const CLIENT_ID_STORAGE_KEY = "dispatcher-client-id";

let cachedClientId: string | null = null;

function randomClientId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `client-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

/**
 * Identifies this window/tab to the backend for the lifetime of the tab.
 *
 * The backend keys terminal subscriptions and viewport requests by client id,
 * so it has to survive a reload (otherwise a refresh would strand the old
 * subscription) but must differ between two tabs of the same browser
 * (otherwise they would replace each other's subscriptions). sessionStorage is
 * scoped exactly that way.
 */
export function getClientId(): string {
  if (cachedClientId) {
    return cachedClientId;
  }

  let stored: string | null = null;
  try {
    stored = window.sessionStorage.getItem(CLIENT_ID_STORAGE_KEY);
  } catch {
    stored = null;
  }

  cachedClientId = stored ?? randomClientId();

  try {
    window.sessionStorage.setItem(CLIENT_ID_STORAGE_KEY, cachedClientId);
  } catch {
    // Private-mode storage failures just mean a new id after reload.
  }

  return cachedClientId;
}
