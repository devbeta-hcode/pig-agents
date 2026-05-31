import type { BrowserWindow } from "electron";
import { getUiZoomPercent } from "./uiPrefs.js";

export function applyWindowZoom(win: BrowserWindow | null | undefined, percent?: number): number {
  if (!win || win.isDestroyed()) return percent ?? getUiZoomPercent();
  const p = percent ?? getUiZoomPercent();
  win.webContents.setZoomFactor(p / 100);
  if (!win.isDestroyed()) win.webContents.send("pig:browser:layout");
  return p;
}
