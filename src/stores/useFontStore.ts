import { create } from "zustand";
import { persist } from "zustand/middleware";

const DEFAULT_FONT_FAMILY = "Menlo";
const DEFAULT_FONT_SIZE = 13;
const DEFAULT_FONT_WEIGHT: FontWeight = "normal";
const DEFAULT_FONT_WEIGHT_BOLD: FontWeight = "bold";
const DEFAULT_LINE_HEIGHT = 1.0;
const DEFAULT_LETTER_SPACING = 0;

const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 32;
const STEP = 1;

type FontWeight = "normal" | "bold" | "100" | "200" | "300" | "400" | "500" | "600" | "700" | "800" | "900";

interface FontStore {
  fontFamily: string;
  fontSize: number;
  fontWeight: FontWeight;
  fontWeightBold: FontWeight;
  lineHeight: number;
  letterSpacing: number;

  increase: () => void;
  decrease: () => void;
  reset: () => void;

  setFontFamily: (family: string) => void;
  setFontSize: (size: number) => void;
  setFontWeight: (weight: FontWeight) => void;
  setFontWeightBold: (weight: FontWeight) => void;
  setLineHeight: (height: number) => void;
  setLetterSpacing: (spacing: number) => void;
  resetAll: () => void;
}

export type { FontWeight };

export const useFontStore = create<FontStore>()(
  persist(
    (set) => ({
      fontFamily: DEFAULT_FONT_FAMILY,
      fontSize: DEFAULT_FONT_SIZE,
      fontWeight: DEFAULT_FONT_WEIGHT,
      fontWeightBold: DEFAULT_FONT_WEIGHT_BOLD,
      lineHeight: DEFAULT_LINE_HEIGHT,
      letterSpacing: DEFAULT_LETTER_SPACING,

      increase: () =>
        set((s) => ({ fontSize: Math.min(MAX_FONT_SIZE, s.fontSize + STEP) })),
      decrease: () =>
        set((s) => ({ fontSize: Math.max(MIN_FONT_SIZE, s.fontSize - STEP) })),
      reset: () => set({ fontSize: DEFAULT_FONT_SIZE }),

      setFontFamily: (family) => set({ fontFamily: family }),
      setFontSize: (size) =>
        set({ fontSize: Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, size)) }),
      setFontWeight: (weight) => set({ fontWeight: weight }),
      setFontWeightBold: (weight) => set({ fontWeightBold: weight }),
      setLineHeight: (height) => set({ lineHeight: height }),
      setLetterSpacing: (spacing) => set({ letterSpacing: spacing }),
      resetAll: () =>
        set({
          fontFamily: DEFAULT_FONT_FAMILY,
          fontSize: DEFAULT_FONT_SIZE,
          fontWeight: DEFAULT_FONT_WEIGHT,
          fontWeightBold: DEFAULT_FONT_WEIGHT_BOLD,
          lineHeight: DEFAULT_LINE_HEIGHT,
          letterSpacing: DEFAULT_LETTER_SPACING,
        }),
    }),
    {
      name: "dispatcher-font",
      migrate: (persisted, version) => {
        // If no persisted state, try to migrate font size from the old key
        if (version === 0 && typeof window !== "undefined") {
          try {
            const oldData = window.localStorage.getItem("dispatcher-font-size");
            if (oldData) {
              const parsed = JSON.parse(oldData);
              if (parsed?.state?.fontSize) {
                return { ...(persisted as object), fontSize: parsed.state.fontSize };
              }
            }
          } catch {
            // Ignore parse errors
          }
        }
        return persisted as FontStore;
      },
      version: 1,
    }
  )
);
