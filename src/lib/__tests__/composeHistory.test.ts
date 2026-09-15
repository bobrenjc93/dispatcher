import { beforeEach, describe, expect, it } from "vitest";
import {
  COMPOSE_HISTORY_LIMIT,
  COMPOSE_HISTORY_START,
  clearComposeHistory,
  loadComposeHistory,
  rememberComposedText,
  stepComposeHistory,
} from "../composeHistory";

describe("rememberComposedText", () => {
  beforeEach(() => {
    clearComposeHistory();
  });

  it("keeps submissions newest first", () => {
    rememberComposedText("first");
    rememberComposedText("second");
    expect(loadComposeHistory()).toEqual(["second", "first"]);
  });

  it("moves a repeat to the front instead of storing it twice", () => {
    // Nudging an agent with the same prompt is routine, and it should not push
    // everything else down a slot each time.
    rememberComposedText("a");
    rememberComposedText("b");
    rememberComposedText("a");
    expect(loadComposeHistory()).toEqual(["a", "b"]);
  });

  it("ignores blank submissions", () => {
    rememberComposedText("   ");
    rememberComposedText("");
    expect(loadComposeHistory()).toEqual([]);
  });

  it("caps the list", () => {
    for (let i = 0; i < COMPOSE_HISTORY_LIMIT + 10; i += 1) {
      rememberComposedText(`entry ${i}`);
    }
    const history = loadComposeHistory();
    expect(history).toHaveLength(COMPOSE_HISTORY_LIMIT);
    expect(history[0]).toBe(`entry ${COMPOSE_HISTORY_LIMIT + 9}`);
  });
});

describe("stepComposeHistory", () => {
  const history = ["newest", "middle", "oldest"];

  it("walks back through the entries", () => {
    const first = stepComposeHistory({
      history,
      cursor: COMPOSE_HISTORY_START,
      current: "",
      direction: "older",
    });
    expect(first?.text).toBe("newest");
    const second = stepComposeHistory({
      history,
      cursor: first!.cursor,
      current: first!.text,
      direction: "older",
    });
    expect(second?.text).toBe("middle");
  });

  it("gives the draft back on the way down", () => {
    // The half-typed text has to survive a look at the history, or the buttons
    // are a trap rather than a convenience.
    const back = stepComposeHistory({
      history,
      cursor: COMPOSE_HISTORY_START,
      current: "half typed",
      direction: "older",
    });
    const forward = stepComposeHistory({
      history,
      cursor: back!.cursor,
      current: back!.text,
      direction: "newer",
    });
    expect(forward?.text).toBe("half typed");
    expect(forward?.cursor.index).toBe(-1);
  });

  it("refuses to step past either end", () => {
    expect(
      stepComposeHistory({
        history,
        cursor: COMPOSE_HISTORY_START,
        current: "",
        direction: "newer",
      })
    ).toBeNull();
    expect(
      stepComposeHistory({
        history,
        cursor: { index: history.length - 1, draft: "" },
        current: "oldest",
        direction: "older",
      })
    ).toBeNull();
  });

  it("has nowhere to go with an empty history", () => {
    expect(
      stepComposeHistory({
        history: [],
        cursor: COMPOSE_HISTORY_START,
        current: "typed",
        direction: "older",
      })
    ).toBeNull();
  });
});
