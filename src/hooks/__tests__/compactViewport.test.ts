import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { COMPACT_VIEWPORT_QUERY } from "../useCompactViewport";

/**
 * The compact breakpoint lives in two places that cannot share a value: the
 * media query string the app matches in JS, and the `@media` block that styles
 * the same layout in CSS. Nothing but this test stops them drifting apart, and
 * drift is quiet — the layout would switch while its styles did not follow, or
 * the reverse.
 */
// Read rather than imported: vitest stubs CSS imports to an empty string, so
// `?raw` would quietly hand this test nothing to compare against.
const APP_CSS = readFileSync(resolve(process.cwd(), "src/App.css"), "utf8");

describe("compact viewport breakpoint", () => {
  it("matches the @media block in App.css exactly", () => {
    const mediaBlocks = [...APP_CSS.matchAll(/@media ([^{]+)\{/g)].map(
      ([, condition]) => condition.trim()
    );

    expect(mediaBlocks).toContain(COMPACT_VIEWPORT_QUERY);
  });

  it("treats a phone in landscape as compact, not just a narrow one", () => {
    // The bug: rotating a phone makes it wider than the breakpoint (an iPhone
    // 15 goes 393px -> 852px) and the desktop layout came back on a 393px-tall
    // screen. Width alone cannot express that; the short edge is the signal.
    expect(COMPACT_VIEWPORT_QUERY).toContain("max-height");
  });

  it("only relaxes the width rule for touch devices", () => {
    // Without these, an ordinary desktop window that happens to be short would
    // flip to the phone layout.
    expect(COMPACT_VIEWPORT_QUERY).toContain("hover: none");
    expect(COMPACT_VIEWPORT_QUERY).toContain("pointer: coarse");
  });

  it("puts the height cutoff between a phone and a tablet in landscape", () => {
    // A phone in landscape is at most ~430px tall; a tablet is at least ~744px
    // and should keep the desktop layout. Anything in that gap works.
    const heightCutoff = Number(
      /max-height:\s*(\d+)px/.exec(COMPACT_VIEWPORT_QUERY)?.[1]
    );

    expect(heightCutoff).toBeGreaterThan(430);
    expect(heightCutoff).toBeLessThan(744);
  });
});
