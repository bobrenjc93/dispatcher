import { describe, expect, it } from "vitest";
import { parseOsc52Copy } from "../osc52";

function encode(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

describe("parseOsc52Copy", () => {
  it("decodes what Claude Code sends for a selection", () => {
    expect(parseOsc52Copy("c;RDEzMzM0NDUxMw==")).toBe("D133344513");
  });

  it("decodes UTF-8 and any selection target", () => {
    expect(parseOsc52Copy(`p;${encode("naïve → ✓")}`)).toBe("naïve → ✓");
    expect(parseOsc52Copy(`;${encode("default target")}`)).toBe("default target");
  });

  it("never answers a request to read the clipboard", () => {
    expect(parseOsc52Copy("c;?")).toBeNull();
  });

  it("ignores empty, malformed and non-text payloads", () => {
    expect(parseOsc52Copy("c;")).toBeNull();
    expect(parseOsc52Copy("no-separator")).toBeNull();
    expect(parseOsc52Copy("c;not base64!")).toBeNull();
    expect(parseOsc52Copy(`c;${btoa("\xff\xfe")}`)).toBeNull();
  });
});
