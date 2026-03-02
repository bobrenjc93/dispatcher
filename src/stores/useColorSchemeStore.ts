import { create } from "zustand";
import { persist } from "zustand/middleware";
import { DEFAULT_SCHEME_ID, getScheme } from "../lib/colorSchemes";
import type { ColorScheme } from "../types/colorScheme";

interface ColorSchemeStore {
  schemeId: string;
  setScheme: (id: string) => void;
  getActiveScheme: () => ColorScheme;
}

export const useColorSchemeStore = create<ColorSchemeStore>()(
  persist(
    (set, get) => ({
      schemeId: DEFAULT_SCHEME_ID,
      setScheme: (id: string) => set({ schemeId: id }),
      getActiveScheme: () => getScheme(get().schemeId),
    }),
    {
      name: "dispatcher-color-scheme",
    }
  )
);
