import { describe, expect, it } from "vitest";
import {
  APP_STATE_LAYOUTS_KEY,
  APP_STATE_PROJECTS_KEY,
  APP_STATE_STORAGE_KEYS,
  APP_STATE_TERMINALS_KEY,
  getScopedStorageKey,
} from "../storageNamespace";
import {
  type AppStateSnapshot,
  writeAppStateSnapshotToLocalStorage,
} from "../appStateSnapshot";

describe("app state snapshot persistence", () => {
  it("mirrors app state into the active storage namespace", () => {
    const snapshot: AppStateSnapshot = {
      [APP_STATE_PROJECTS_KEY]: {
        state: {
          projects: {},
          nodes: {},
          activeProjectId: null,
          projectOrder: [],
        },
        version: 0,
      },
      [APP_STATE_TERMINALS_KEY]: {
        state: {
          sessions: {},
          activeTerminalId: null,
        },
        version: 0,
      },
      [APP_STATE_LAYOUTS_KEY]: {
        state: {
          layouts: {},
        },
        version: 0,
      },
    };

    expect(writeAppStateSnapshotToLocalStorage(snapshot)).toBe(true);

    for (const key of APP_STATE_STORAGE_KEYS) {
      const scopedKey = getScopedStorageKey(key);
      expect(window.localStorage.getItem(scopedKey)).toBe(JSON.stringify(snapshot[key]));
      if (scopedKey !== key) {
        expect(window.localStorage.getItem(key)).toBeNull();
      }
    }
  });
});
