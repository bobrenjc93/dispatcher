import { describe, expect, it } from "vitest";

import { findTerminalWebLinkMatches } from "../terminalLinks";

function createLine(text: string, isWrapped = false) {
  return {
    isWrapped,
    length: text.length,
    translateToString: (trimRight?: boolean) => (trimRight ? text.trimEnd() : text),
  };
}

function createTerminal(lines: Array<ReturnType<typeof createLine>>, cols = 80) {
  return {
    cols,
    buffer: {
      active: {
        getLine: (lineNumber: number) => lines[lineNumber],
      },
    },
  };
}

describe("terminalLinks", () => {
  it("opens a URL that xterm soft-wrapped across rows", () => {
    const terminal = createTerminal([
      createLine("Open http://example.com/review/loc"),
      createLine("al?agentreviewSession=abc123", true),
    ]);

    const links = findTerminalWebLinkMatches(terminal, 2);

    expect(links).toEqual([
      {
        text: "http://example.com/review/local?agentreviewSession=abc123",
        range: {
          start: { x: 6, y: 1 },
          end: { x: 29, y: 2 },
        },
      },
    ]);
  });

  it("treats a full hard-wrapped row as a URL continuation when tmux did not preserve soft-wrap metadata", () => {
    const firstRow = "Open http://example.com/review/loc";
    const terminal = createTerminal(
      [
        createLine(firstRow),
        createLine("al?agentreviewSession=abc123"),
      ],
      firstRow.length
    );

    const links = findTerminalWebLinkMatches(terminal, 1);

    expect(links.map((link) => link.text)).toEqual([
      "http://example.com/review/local?agentreviewSession=abc123",
    ]);
    expect(links[0].range.end).toEqual({ x: 29, y: 2 });
  });

  it("does not join ordinary adjacent rows that did not reach the terminal width", () => {
    const terminal = createTerminal([
      createLine("Open http://example.com/review/loc"),
      createLine("al?agentreviewSession=abc123"),
    ]);

    const links = findTerminalWebLinkMatches(terminal, 1);

    expect(links.map((link) => link.text)).toEqual(["http://example.com/review/loc"]);
  });

  it("follows a URL onto an indented row under a bullet", () => {
    const first = "● The report is live: https://bobrenjc93.github.io/explanat";
    const terminal = createTerminal(
      [
        createLine(first),
        createLine("  ions/frame-stack-chunks/ — \"A quarter of a training step,"),
        createLine("  lost to one Python frame\"."),
      ],
      first.length
    );

    for (const row of [1, 2]) {
      const links = findTerminalWebLinkMatches(terminal, row);
      expect(links).toEqual([
        {
          text: "https://bobrenjc93.github.io/explanations/frame-stack-chunks/",
          range: {
            start: { x: 23, y: 1 },
            end: { x: 27, y: 2 },
          },
        },
      ]);
    }
  });

  it("follows an indented URL across several full rows", () => {
    const terminal = createTerminal(
      [
        createLine("- see https://example.com/aaaa"),
        createLine("  bbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
        createLine("  cccc done"),
      ],
      30
    );

    const links = findTerminalWebLinkMatches(terminal, 3);

    expect(links.map((link) => link.text)).toEqual([
      "https://example.com/aaaabbbbbbbbbbbbbbbbbbbbbbbbbbbbcccc",
    ]);
    expect(links[0].range).toEqual({ start: { x: 7, y: 1 }, end: { x: 7, y: 3 } });
  });

  it("does not run a URL into indented prose after a full row of prose", () => {
    const terminal = createTerminal(
      [
        createLine("- see https://example.com/a and"),
        createLine("  then more words"),
      ],
      31
    );

    const links = findTerminalWebLinkMatches(terminal, 1);

    expect(links.map((link) => link.text)).toEqual(["https://example.com/a"]);
  });

  it("maps a URL that starts at the beginning of a wrapped row to that row", () => {
    const terminal = createTerminal([
      createLine("prefix "),
      createLine("http://example.com/review/local", true),
    ]);

    const links = findTerminalWebLinkMatches(terminal, 2);

    expect(links[0].range.start).toEqual({ x: 1, y: 2 });
  });

  it("excludes sentence punctuation from the URL", () => {
    const terminal = createTerminal([
      createLine("Open http://example.com/review/local?agentreviewSession=abc123."),
    ]);

    const links = findTerminalWebLinkMatches(terminal, 1);

    expect(links.map((link) => link.text)).toEqual([
      "http://example.com/review/local?agentreviewSession=abc123",
    ]);
  });
});
