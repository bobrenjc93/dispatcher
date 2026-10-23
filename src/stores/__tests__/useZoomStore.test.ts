import { beforeEach, describe, expect, it } from "vitest";
import { useZoomStore } from "../useZoomStore";

describe("useZoomStore", () => {
  beforeEach(() => {
    useZoomStore.setState({ zoom: 1 });
  });

  it("steps through browser zoom levels", () => {
    useZoomStore.getState().zoomIn();
    expect(useZoomStore.getState().zoom).toBe(1.1);
    useZoomStore.getState().zoomIn();
    expect(useZoomStore.getState().zoom).toBe(1.25);
    useZoomStore.getState().zoomOut();
    useZoomStore.getState().zoomOut();
    useZoomStore.getState().zoomOut();
    expect(useZoomStore.getState().zoom).toBe(0.9);
  });

  it("stops at the ends", () => {
    useZoomStore.setState({ zoom: 3 });
    useZoomStore.getState().zoomIn();
    expect(useZoomStore.getState().zoom).toBe(3);
    useZoomStore.setState({ zoom: 0.5 });
    useZoomStore.getState().zoomOut();
    expect(useZoomStore.getState().zoom).toBe(0.5);
  });

  it("resetZoom returns to 100%", () => {
    useZoomStore.setState({ zoom: 2 });
    useZoomStore.getState().resetZoom();
    expect(useZoomStore.getState().zoom).toBe(1);
  });
});
