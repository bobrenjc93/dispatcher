const DEV_STORAGE_PREFIX = "dispatcher-dev:";
const DEV_NATIVE_STORAGE_NAMESPACE = "dev";

// These are the canonical app-state keys used in exported/imported snapshots.
// Production localStorage intentionally keeps using the same names so existing
// installed apps continue to load their current state after this change.
export const APP_STATE_PROJECTS_KEY = "dispatcher-projects";
export const APP_STATE_TERMINALS_KEY = "dispatcher-terminals";
export const APP_STATE_LAYOUTS_KEY = "dispatcher-layouts";

export const APP_STATE_STORAGE_KEYS = [
  APP_STATE_PROJECTS_KEY,
  APP_STATE_TERMINALS_KEY,
  APP_STATE_LAYOUTS_KEY,
] as const;

export type AppStateStorageKey = typeof APP_STATE_STORAGE_KEYS[number];

export function isDevStorageNamespace(): boolean {
  return import.meta.env.DEV;
}

export function getStorageNamespaceLabel(): "prod" | "dev" {
  return isDevStorageNamespace() ? "dev" : "prod";
}

export function getScopedStorageKeyForNamespace(
  baseKey: string,
  namespace: "prod" | "dev"
): string {
  // Tauri dev and the packaged app can share a WebView data directory. Prefix
  // only dev keys so local development cannot read or overwrite prod state.
  return namespace === "dev" ? `${DEV_STORAGE_PREFIX}${baseKey}` : baseKey;
}

export function getScopedStorageKey(baseKey: string): string {
  return getScopedStorageKeyForNamespace(baseKey, getStorageNamespaceLabel());
}

export function getScopedAppStateStorageKey(baseKey: AppStateStorageKey): string {
  return getScopedStorageKey(baseKey);
}

export function getScopedAppStateStorageKeys(): Record<AppStateStorageKey, string> {
  return {
    [APP_STATE_PROJECTS_KEY]: getScopedAppStateStorageKey(APP_STATE_PROJECTS_KEY),
    [APP_STATE_TERMINALS_KEY]: getScopedAppStateStorageKey(APP_STATE_TERMINALS_KEY),
    [APP_STATE_LAYOUTS_KEY]: getScopedAppStateStorageKey(APP_STATE_LAYOUTS_KEY),
  };
}

export function getNativeStorageNamespaceForNamespace(namespace: "prod" | "dev"): string | null {
  // Native commands use null for prod to preserve the existing backup filename.
  return namespace === "dev" ? DEV_NATIVE_STORAGE_NAMESPACE : null;
}

export function getNativeStorageNamespace(): string | null {
  return getNativeStorageNamespaceForNamespace(getStorageNamespaceLabel());
}

export function isDispatcherStorageKey(key: string): boolean {
  return key.startsWith("dispatcher") || key.startsWith(DEV_STORAGE_PREFIX);
}
