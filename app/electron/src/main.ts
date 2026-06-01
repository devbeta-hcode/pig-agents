import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, Menu, shell } from "electron";
import { getAppIcon } from "./appIcon.js";
import { cleanupTerminals, registerIpc } from "./ipc/register.js";
import { loadDesktopEnv } from "./env.js";
import { getUiZoomPercent } from "./uiPrefs.js";
import { applyWindowZoom } from "./zoom.js";
import { logger as log } from "@pig-agents/core";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;

const isDev = process.env.PIG_DEV === "1";
const RENDERER_DEV_URL = "http://127.0.0.1:5190";

// Keep stray async failures (e.g. a child-process spawn error) from tearing
// down the whole app with the default "A JavaScript error occurred" dialog.
process.on("uncaughtException", (err) => log.error("uncaughtException", err));
process.on("unhandledRejection", (reason) => log.error("unhandledRejection", reason));

function preloadPath(): string {
  return path.join(__dirname, "preload.js");
}

/** Prod packaged layout: builder-effective-config maps renderer/dist → `renderer/`. */
function rendererIndexPath(): string {
  if (isDev) {
    return path.join(__dirname, "../../renderer/dist/index.html");
  }
  if (app.isPackaged) {
    return path.join(app.getAppPath(), "renderer/index.html");
  }
  // Unpackaged prod smoke (`electron .` after build) — monorepo paths still apply.
  return path.join(__dirname, "../../renderer/dist/index.html");
}

function wireWindowChrome(win: BrowserWindow): void {
  const sendMax = (maximized: boolean) => {
    if (!win.isDestroyed()) win.webContents.send("pig:window:maximized", maximized);
  };
  win.on("maximize", () => sendMax(true));
  win.on("unmaximize", () => sendMax(false));
}

async function createWindow() {
  const appIcon = getAppIcon();
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    roundedCorners: true,
    hasShadow: true,
    title: "Pig Agents",
    icon: appIcon.isEmpty() ? undefined : appIcon,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: isDev,
      webviewTag: true,
    },
  });
  wireWindowChrome(mainWindow);
  mainWindow.webContents.on("did-finish-load", () => {
    applyWindowZoom(mainWindow, getUiZoomPercent());
  });
  mainWindow.on("ready-to-show", () => mainWindow?.show());
  mainWindow.webContents.on("did-fail-load", (_ev, code, desc, url) => {
    log.error("renderer did-fail-load", { code, desc, url });
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show();
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  try {
    if (isDev) {
      await mainWindow.loadURL(RENDERER_DEV_URL);
      mainWindow.webContents.openDevTools({ mode: "detach" });
      log.info("window loaded (dev)", { url: RENDERER_DEV_URL });
    } else {
      const indexPath = rendererIndexPath();
      if (!fs.existsSync(indexPath)) {
        log.error("renderer index.html missing", {
          indexPath,
          appPath: app.getAppPath(),
          dirname: __dirname,
          isPackaged: app.isPackaged,
        });
      }
      await mainWindow.loadFile(indexPath);
      log.info("window loaded (prod)", { file: indexPath });
    }
  } catch (err) {
    log.error("Failed to load renderer", err);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
  }
  // If load hangs (bad path, CSP, etc.) avoid a headless process with no window.
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      log.warn("forcing window show — ready-to-show did not fire");
      mainWindow.show();
    }
  }, 12_000);
}
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}
else {
  app.on("second-instance", () => {
    // Someone tried to run a second instance, we should focus our window.
    if (mainWindow) {
      if (mainWindow.isMinimized())
        mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(async () => {
    if (process.platform === "win32") {
      app.setAppUserModelId("com.devbeta.pig-agents-desktop");
    }
    const dockIcon = getAppIcon();
    if (process.platform === "darwin" && !dockIcon.isEmpty()) {
      app.dock?.setIcon(dockIcon);
    }
    Menu.setApplicationMenu(null);
    loadDesktopEnv();
    registerIpc(() => mainWindow);
    await createWindow();
    app.on("activate", async () => {
      if (BrowserWindow.getAllWindows().length === 0)
        await createWindow();
    });
  });
  app.on("before-quit", () => {
    cleanupTerminals();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin")
      app.quit();
  });
}
