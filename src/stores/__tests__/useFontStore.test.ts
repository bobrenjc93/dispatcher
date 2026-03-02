import { describe, it, expect } from "vitest";
import { useFontStore } from "../useFontStore";

describe("useFontStore", () => {
  it("increase from default (13) → 14", () => {
    expect(useFontStore.getState().fontSize).toBe(13);
    useFontStore.getState().increase();
    expect(useFontStore.getState().fontSize).toBe(14);
  });

  it("decrease from default (13) → 12", () => {
    useFontStore.getState().decrease();
    expect(useFontStore.getState().fontSize).toBe(12);
  });

  it("capped at max (32)", () => {
    useFontStore.setState({ fontSize: 32 });
    useFontStore.getState().increase();
    expect(useFontStore.getState().fontSize).toBe(32);
  });

  it("capped at min (8)", () => {
    useFontStore.setState({ fontSize: 8 });
    useFontStore.getState().decrease();
    expect(useFontStore.getState().fontSize).toBe(8);
  });

  it("reset returns fontSize to 13", () => {
    useFontStore.setState({ fontSize: 20 });
    useFontStore.getState().reset();
    expect(useFontStore.getState().fontSize).toBe(13);
  });

  it("setFontFamily updates family", () => {
    useFontStore.getState().setFontFamily("Fira Code");
    expect(useFontStore.getState().fontFamily).toBe("Fira Code");
  });

  it("setFontSize clamps to range", () => {
    useFontStore.getState().setFontSize(50);
    expect(useFontStore.getState().fontSize).toBe(32);
    useFontStore.getState().setFontSize(2);
    expect(useFontStore.getState().fontSize).toBe(8);
  });

  it("setFontWeight updates weight", () => {
    useFontStore.getState().setFontWeight("300");
    expect(useFontStore.getState().fontWeight).toBe("300");
  });

  it("setFontWeightBold updates bold weight", () => {
    useFontStore.getState().setFontWeightBold("900");
    expect(useFontStore.getState().fontWeightBold).toBe("900");
  });

  it("setLineHeight updates line height", () => {
    useFontStore.getState().setLineHeight(1.5);
    expect(useFontStore.getState().lineHeight).toBe(1.5);
  });

  it("setLetterSpacing updates letter spacing", () => {
    useFontStore.getState().setLetterSpacing(2);
    expect(useFontStore.getState().letterSpacing).toBe(2);
  });

  it("resetAll restores all defaults", () => {
    useFontStore.setState({
      fontFamily: "Fira Code",
      fontSize: 20,
      fontWeight: "300",
      fontWeightBold: "900",
      lineHeight: 1.5,
      letterSpacing: 3,
    });
    useFontStore.getState().resetAll();
    const state = useFontStore.getState();
    expect(state.fontFamily).toBe("Menlo");
    expect(state.fontSize).toBe(13);
    expect(state.fontWeight).toBe("normal");
    expect(state.fontWeightBold).toBe("bold");
    expect(state.lineHeight).toBe(1.0);
    expect(state.letterSpacing).toBe(0);
  });
});
