/**
 * Detect which monospace fonts are available on the system using canvas measurement.
 */

const MONOSPACE_FONTS = [
  "Menlo",
  "Monaco",
  "SF Mono",
  "Fira Code",
  "JetBrains Mono",
  "Source Code Pro",
  "IBM Plex Mono",
  "Cascadia Code",
  "Cascadia Mono",
  "Consolas",
  "Inconsolata",
  "Ubuntu Mono",
  "Roboto Mono",
  "Hack",
  "DejaVu Sans Mono",
  "Courier New",
  "Droid Sans Mono",
] as const;

const TEST_STRING = "mmmmmmmmmmlli1|WW";
const TEST_SIZE = "72px";
const BASELINE_FONT = "monospace";

let cachedFonts: string[] | null = null;

export function detectAvailableFonts(): string[] {
  if (cachedFonts) return cachedFonts;
  if (typeof document === "undefined") return [MONOSPACE_FONTS[0]];

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return [MONOSPACE_FONTS[0]];

  // Measure baseline width using generic monospace
  ctx.font = `${TEST_SIZE} ${BASELINE_FONT}`;
  const baselineWidth = ctx.measureText(TEST_STRING).width;

  const available: string[] = [];

  for (const font of MONOSPACE_FONTS) {
    ctx.font = `${TEST_SIZE} "${font}", ${BASELINE_FONT}`;
    const width = ctx.measureText(TEST_STRING).width;
    // If the width differs from the baseline, the font is installed
    if (width !== baselineWidth) {
      available.push(font);
    }
  }

  // Always include the baseline fallback if nothing else was detected
  if (available.length === 0) {
    available.push(MONOSPACE_FONTS[0]);
  }

  cachedFonts = available;
  return available;
}

export function clearFontCache(): void {
  cachedFonts = null;
}
