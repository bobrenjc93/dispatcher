import { describe, expect, it } from "vitest";
import {
  getNativeStorageNamespaceForNamespace,
  getScopedStorageKeyForNamespace,
  isDispatcherStorageKey,
} from "../storageNamespace";

describe("storage namespace", () => {
  it("keeps production storage keys stable", () => {
    expect(getScopedStorageKeyForNamespace("dispatcher-projects", "prod")).toBe("dispatcher-projects");
    expect(getNativeStorageNamespaceForNamespace("prod")).toBeNull();
  });

  it("moves development storage into its own namespace", () => {
    expect(getScopedStorageKeyForNamespace("dispatcher-projects", "dev")).toBe(
      "dispatcher-dev:dispatcher-projects"
    );
    expect(getNativeStorageNamespaceForNamespace("dev")).toBe("dev");
  });

  it("recognizes both old production and new development dispatcher keys", () => {
    expect(isDispatcherStorageKey("dispatcher-projects")).toBe(true);
    expect(isDispatcherStorageKey("dispatcher-dev:dispatcher-projects")).toBe(true);
    expect(isDispatcherStorageKey("other-app")).toBe(false);
  });
});
