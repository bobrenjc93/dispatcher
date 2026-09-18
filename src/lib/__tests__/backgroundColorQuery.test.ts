import { describe, expect, it } from "vitest";
import {
  buildBackgroundColorReply,
  hasBackgroundColorQuery,
  stripBackgroundColorQuery,
} from "../backgroundColorQuery";

const ESC = "\u001b";
const BEL = "\u0007";
const ST = "\u001b\\";

describe("hasBackgroundColorQuery", () => {
  it("finds the question in both terminators", () => {
    expect(hasBackgroundColorQuery(`${ESC}]11;?${BEL}`)).toBe(true);
    expect(hasBackgroundColorQuery(`${ESC}]11;?${ST}`)).toBe(true);
  });

  it("finds it buried in ordinary output", () => {
    expect(hasBackgroundColorQuery(`hello\r\n${ESC}]11;?${ST}world`)).toBe(true);
  });

  it("is not fooled by an answer or a neighbouring sequence", () => {
    // The reply carries the same number and must not read as another question,
    // or answering would answer itself forever.
    expect(hasBackgroundColorQuery(`${ESC}]11;rgb:0a0a/0a0a/0a0a${ST}`)).toBe(false);
    expect(hasBackgroundColorQuery(`${ESC}]10;?${ST}`)).toBe(false);
    expect(hasBackgroundColorQuery(`${ESC}]112;?${ST}`)).toBe(false);
    expect(hasBackgroundColorQuery("no escapes here")).toBe(false);
  });

  it("answers the same way twice", () => {
    // The pattern is global; a leaked lastIndex would make the second call
    // disagree with the first.
    const chunk = `${ESC}]11;?${ST}`;
    expect(hasBackgroundColorQuery(chunk)).toBe(true);
    expect(hasBackgroundColorQuery(chunk)).toBe(true);
  });
});

describe("stripBackgroundColorQuery", () => {
  it("takes the question out and leaves the rest", () => {
    // Left in, the renderer answers it too and the program reads the second
    // reply as keystrokes.
    expect(stripBackgroundColorQuery(`before${ESC}]11;?${ST}after`)).toBe("beforeafter");
  });

  it("leaves output without a question alone", () => {
    expect(stripBackgroundColorQuery("plain output")).toBe("plain output");
  });
});

describe("buildBackgroundColorReply", () => {
  it("doubles each channel, the way every terminal reports it", () => {
    expect(buildBackgroundColorReply("#0a0a0a")).toBe(
      `${ESC}]11;rgb:0a0a/0a0a/0a0a${ST}`
    );
  });

  it("takes a short hex and a bare one", () => {
    expect(buildBackgroundColorReply("#000")).toBe(`${ESC}]11;rgb:0000/0000/0000${ST}`);
    expect(buildBackgroundColorReply("1E2A3B")).toBe(`${ESC}]11;rgb:1e1e/2a2a/3b3b${ST}`);
  });

  it("declines anything it cannot describe", () => {
    // Better to answer nothing than to answer wrongly: a malformed reply is
    // read as keystrokes.
    expect(buildBackgroundColorReply("rgb(10,10,10)")).toBeNull();
    expect(buildBackgroundColorReply("")).toBeNull();
  });
});
