import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, Menu, shell } from "electron";
import { getAppIcon } from "./appIcon.js";
import { registerIpc } from "./ipc/register.js";
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

function rendererIndexPath(): string {
  return path.join(__dirname, "../../renderer/dist/index.html");
}

function wireWindowChrome(win: BrowserWindow): void {
  const sendMax = (maximized: boolean) => {
    if (!win.isDestroyed()) win.webContents.send("pig:window:maximized", maximized);
  };
  win.on("maximize", () => sendMax(true));
  win.on("unmaximize", () => sendMax(false));
}

async function createWindow(): Promise<void> {
  const appIcon = getAppIcon();

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    frame: false,
    // Opaque on Windows — transparent frameless windows misalign BrowserView bounds.
    transparent: process.platform !== "win32",
    backgroundColor: process.platform === "win32" ? "#121218" : "#00000000",
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

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  if (isDev) {
    await mainWindow.loadURL(RENDERER_DEV_URL);
    mainWindow.webContents.openDevTools({ mode: "detach" });
    log.info("window loaded (dev)", { url: RENDERER_DEV_URL });
  } else {
    await mainWindow.loadFile(rendererIndexPath());
    log.info("window loaded (prod)", { file: rendererIndexPath() });
  }
}

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
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
