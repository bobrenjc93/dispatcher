import { describe, expect, it } from "vitest";
import {
  describeViewportChange,
  hashViewportLines,
  resolveViewportChange,
} from "../viewportSignature";

describe("hashViewportLines", () => {
  it("matches only for the same screen", () => {
    const screen = ["hello", "world"];
    expect(hashViewportLines(screen)).toBe(hashViewportLines(["hello", "world"]));
    expect(hashViewportLines(screen)).not.toBe(hashViewportLines(["hello", "worlds"]));
  });

  it("notices text moving between lines", () => {
    // Concatenating the lines would call these the same screen, and a TUI
    // scrolling its output by one row is exactly that shape.
    expect(hashViewportLines(["ab", "c"])).not.toBe(hashViewportLines(["a", "bc"]));
    expect(hashViewportLines(["a", "b"])).not.toBe(hashViewportLines(["ab"]));
  });

  it("notices a colour-only change", () => {
    // Captures come from `capture-pane -e`, so styling is part of the screen.
    // A line that only changes colour has changed.
    expect(hashViewportLines(["[31mdone[0m"]))
      .not.toBe(hashViewportLines(["[32mdone[0m"]));
  });

  it("handles an empty screen", () => {
    expect(hashViewportLines([])).toBe(hashViewportLines([]));
    expect(hashViewportLines([])).not.toBe(hashViewportLines([""]));
  });
});

describe("resolveViewportChange", () => {
  it("reports a change and a repaint that changed nothing", () => {
    expect(resolveViewportChange({ signature: "a", previousSignature: "a" })).toBe("unchanged");
    expect(resolveViewportChange({ signature: "a", previousSignature: "b" })).toBe("changed");
  });

  it("says so rather than guessing when there is no baseline", () => {
    // First capture after a restart. Treating it as unchanged would clear a
    // tab that may well have been working the whole time.
    expect(resolveViewportChange({ signature: "a", previousSignature: null })).toBe("unknown");
  });
});

describe("describeViewportChange", () => {
  it("reports the first differing row, both ways round", () => {
    const description = describeViewportChange(
      ["same", "old text", "tail"],
      ["same", "new text", "tail"]
    );
    expect(description.changedRows).toBe(1);
    expect(description.firstChangedRow).toBe(1);
    expect(description.before).toBe("old text");
    expect(description.after).toBe("new text");
    // "old" vs "new" is three characters.
    expect(description.changedChars).toBe(3);
  });

  it("counts rows appearing and disappearing", () => {
    expect(describeViewportChange(["a"], ["a", "b"]).changedRows).toBe(1);
    expect(describeViewportChange(["a", "b"], ["a"]).changedRows).toBe(1);
  });

  it("says nothing changed when the screens match", () => {
    const description = describeViewportChange(["a", "b"], ["a", "b"]);
    expect(description).toEqual({
      changedRows: 0,
      changedChars: 0,
      firstChangedRow: null,
      before: "",
      after: "",
    });
  });
});
