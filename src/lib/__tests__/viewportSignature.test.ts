import { describe, expect, it } from "vitest";
import {
  describeViewportChange,
  isDecorationOnlyChange,
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
      changedTextRows: 0,
      changedTextChars: 0,
      firstChangedRow: null,
      before: "",
      after: "",
    });
  });

  it("separates what was redrawn from what was written", () => {
    // The row a spinner tick actually produced: a grey space becomes a green
    // bullet, and everything after it is identical. Hundreds of bytes differ,
    // one character does.
    const before = "\u001b[0;38;5;246m \u001b[0;30;40m \u001b[0;1mBash\u001b[0m(sleep 240)";
    const after = "\u001b[0;38;5;114m\u25cf\u001b[0;30;40m \u001b[0;1mBash\u001b[0m(sleep 240)";
    const change = describeViewportChange([before], [after]);
    expect(change.changedRows).toBe(1);
    expect(change.changedChars).toBeGreaterThan(3);
    expect(change.changedTextRows).toBe(1);
    expect(change.changedTextChars).toBe(1);
  });

  it("counts a recolour with identical text as no text change at all", () => {
    const change = describeViewportChange(
      ["\u001b[31mstill running\u001b[0m"],
      ["\u001b[32mstill running\u001b[0m"]
    );
    expect(change.changedRows).toBe(1);
    expect(change.changedTextRows).toBe(0);
    expect(change.changedTextChars).toBe(0);
  });
});

describe("isDecorationOnlyChange", () => {
  const spinnerTick = () =>
    describeViewportChange(
      [
        "\u001b[0;38;5;246m \u001b[0mBash(sleep 240)",
        "\u001b[0;2m  \u001b[0mwaiting",
      ],
      [
        "\u001b[0;38;5;114m\u25cf\u001b[0mBash(sleep 240)",
        "\u001b[0;2m  \u001b[0mwaiting",
      ]
    );

  it("calls a spinner tick decoration", () => {
    expect(isDecorationOnlyChange(spinnerTick())).toBe(true);
  });

  it("does not call a screen of new output decoration", () => {
    // The shape every measured real wake had: dozens of rows rewritten.
    const previous = Array.from({ length: 60 }, (_, row) => `old line ${row}`);
    const current = Array.from({ length: 60 }, (_, row) => `new content ${row}`);
    expect(isDecorationOnlyChange(describeViewportChange(previous, current))).toBe(false);
  });

  it("does not call a new line of text decoration", () => {
    // One row, but thirteen characters of it: the sort of thing worth looking
    // at, and above the limit on purpose.
    const change = describeViewportChange(["Running tests"], ["All 42 passed, 0 failed"]);
    expect(change.changedTextRows).toBe(1);
    expect(isDecorationOnlyChange(change)).toBe(false);
  });

  it("is not a verdict on screens that match", () => {
    expect(isDecorationOnlyChange(describeViewportChange(["a"], ["a"]))).toBe(false);
  });
});
