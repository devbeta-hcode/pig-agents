import Store from "electron-store";

const MIN_ZOOM = 80;
const MAX_ZOOM = 200;
const DEFAULT_ZOOM = 100;

interface UiPrefsSchema {
  uiZoomPercent: number;
}

const store = new Store<UiPrefsSchema>({
  name: "ui-prefs",
  defaults: { uiZoomPercent: DEFAULT_ZOOM },
});

function clampZoom(percent: number): number {
  const n = Math.round(Number(percent));
  if (!Number.isFinite(n)) return DEFAULT_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, n));
}

export function getUiZoomPercent(): number {
  return clampZoom(store.get("uiZoomPercent"));
}

export function setUiZoomPercent(percent: number): number {
  const v = clampZoom(percent);
  store.set("uiZoomPercent", v);
  return v;
}

export function stepUiZoomPercent(delta: number): number {
  return setUiZoomPercent(getUiZoomPercent() + delta);
}

export const UI_ZOOM_MIN = MIN_ZOOM;
export const UI_ZOOM_MAX = MAX_ZOOM;
export const UI_ZOOM_DEFAULT = DEFAULT_ZOOM;
