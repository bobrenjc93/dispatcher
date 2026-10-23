import { create } from "zustand";
import { persist } from "zustand/middleware";
import { getScopedStorageKey } from "../lib/storageNamespace";

// Chrome's zoom steps, so Cmd+= / Cmd+- feel like a browser.
const ZOOM_LEVELS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const DEFAULT_ZOOM = 1;

interface ZoomStore {
  zoom: number;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
}

function clampZoom(zoom: number): number {
  return Math.max(ZOOM_LEVELS[0], Math.min(ZOOM_LEVELS[ZOOM_LEVELS.length - 1], zoom));
}

export const useZoomStore = create<ZoomStore>()(
  persist(
    (set) => ({
      zoom: DEFAULT_ZOOM,
      zoomIn: () =>
        set((s) => ({ zoom: ZOOM_LEVELS.find((level) => level > s.zoom + 0.001) ?? s.zoom })),
      zoomOut: () =>
        set((s) => ({
          zoom: [...ZOOM_LEVELS].reverse().find((level) => level < s.zoom - 0.001) ?? s.zoom,
        })),
      resetZoom: () => set({ zoom: DEFAULT_ZOOM }),
    }),
    {
      name: getScopedStorageKey("dispatcher-zoom"),
      merge: (persisted, current) => {
        const zoom = (persisted as Partial<ZoomStore> | undefined)?.zoom;
        return typeof zoom === "number" && Number.isFinite(zoom)
          ? { ...current, zoom: clampZoom(zoom) }
          : current;
      },
    }
  )
);
