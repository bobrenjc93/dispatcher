import { describe, expect, it } from "vitest";
import { buildInactionChime, INACTION_CHIME_SECONDS } from "../inactionNotification";

describe("buildInactionChime", () => {
  it("lasts the full alert rather than a blip", () => {
    // The old alert was two notes totalling about a quarter of a second, which
    // is easy to miss from another room.
    const notes = buildInactionChime();
    const last = notes[notes.length - 1];
    expect(last.offset + last.duration).toBeCloseTo(INACTION_CHIME_SECONDS, 5);
  });

  it("starts immediately", () => {
    expect(buildInactionChime()[0].offset).toBe(0);
  });

  it("repeats a motif instead of holding one tone", () => {
    // A sustained note reads as a fault; a pattern is noticeable without
    // being startling.
    const notes = buildInactionChime();
    expect(notes.length).toBeGreaterThan(2);
    expect(new Set(notes.map((n) => n.frequency)).size).toBe(2);
  });

  it("is short enough not to grate", () => {
    // Three seconds was accurate and annoying.
    expect(INACTION_CHIME_SECONDS).toBeLessThanOrEqual(1);
  });

  it("never schedules a note past the end", () => {
    const notes = buildInactionChime(1);
    for (const note of notes) {
      expect(note.offset).toBeLessThan(1);
      expect(note.offset + note.duration).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it("scales to a requested length", () => {
    const short = buildInactionChime(1);
    const long = buildInactionChime(5);
    expect(long.length).toBeGreaterThan(short.length);
    const lastLong = long[long.length - 1];
    expect(lastLong.offset + lastLong.duration).toBeCloseTo(5, 5);
  });
});
