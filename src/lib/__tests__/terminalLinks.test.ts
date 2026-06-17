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
