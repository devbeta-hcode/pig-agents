import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, nativeImage, type NativeImage } from "electron";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Directory with `icon.png` / `icon.ico` (dev: app/electron/resources; packaged: process.resourcesPath). */
function iconResourceDir(): string {
  if (app.isPackaged) return process.resourcesPath;
  return path.join(__dirname, "../resources");
}

/** Best icon file for the current OS (window, dock, notifications). */
export function resolveAppIconPath(): string {
  const dir = iconResourceDir();
  const ico = path.join(dir, "icon.ico");
  const png = path.join(dir, "icon.png");
  if (process.platform === "win32" && fs.existsSync(ico)) return ico;
  if (fs.existsSync(png)) return png;
  return ico;
}

export function getAppIcon(): NativeImage {
  const p = resolveAppIconPath();
  if (!fs.existsSync(p)) return nativeImage.createEmpty();
  return nativeImage.createFromPath(p);
}
