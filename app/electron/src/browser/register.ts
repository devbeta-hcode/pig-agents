import { ipcMain, type BrowserWindow } from "electron";
import { setBrowserDriver } from "@pig-agents/core";
import { createElectronBrowserDriver } from "./electronDriver.js";
import {
  browserCaptureScreenshot,
  browserFocus,
  browserGoBack,
  browserGoForward,
  browserNavigate,
  browserPageZoom,
  browserReload,
  browserHardReload,
  browserClearBrowsingData,
  browserStartInspect,
  browserStop,
  browserStopInspect,
  browserToggleDevTools,
  browserDevToolsOpen,
  getBrowserState,
  initBrowserController,
  registerBrowserGuest,
  unregisterBrowserGuest,
  setBrowserBounds,
  setBrowserOverlaySuppressed,
  setBrowserTabActive,
  setBrowserVisible,
} from "./controller.js";

export function registerBrowser(getWindow: () => BrowserWindow | null): void {
  initBrowserController(getWindow);
  setBrowserDriver(createElectronBrowserDriver());

  ipcMain.handle("pig:browser:setVisible", (_e, visible: boolean) => {
    setBrowserVisible(!!visible);
    return getBrowserState();
  });

  ipcMain.handle(
    "pig:browser:setBounds",
    (_e, bounds: { x: number; y: number; width: number; height: number } | null) => {
      setBrowserBounds(bounds);
      return { ok: true as const };
    },
  );

  ipcMain.handle("pig:browser:setOverlaySuppressed", (_e, suppressed: boolean) => {
    setBrowserOverlaySuppressed(!!suppressed);
    return { ok: true as const };
  });

  ipcMain.handle("pig:browser:setTabActive", (_e, active: boolean) => {
    setBrowserTabActive(!!active);
    return { ok: true as const };
  });

  ipcMain.handle("pig:browser:registerGuest", (_e, guestId: number) => {
    registerBrowserGuest(guestId);
    return getBrowserState();
  });

  ipcMain.handle("pig:browser:unregisterGuest", (_e, guestId: number) => {
    unregisterBrowserGuest(guestId);
    return { ok: true as const };
  });

  ipcMain.handle("pig:browser:navigate", async (_e, url: string) => {
    await browserNavigate(url);
    return getBrowserState();
  });

  ipcMain.handle("pig:browser:back", async () => {
    await browserGoBack();
    return getBrowserState();
  });

  ipcMain.handle("pig:browser:forward", async () => {
    await browserGoForward();
    return getBrowserState();
  });

  ipcMain.handle("pig:browser:reload", async () => {
    browserReload();
    return getBrowserState();
  });

  ipcMain.handle("pig:browser:hardReload", async () => {
    await browserHardReload();
    return getBrowserState();
  });

  ipcMain.handle(
    "pig:browser:clearData",
    async (_e, kind: "history" | "cookies" | "cache") => {
      await browserClearBrowsingData(kind);
      return { ok: true as const };
    },
  );

  ipcMain.handle("pig:browser:getState", () => getBrowserState());

  ipcMain.handle("pig:browser:focus", () => {
    browserFocus();
    return { ok: true as const };
  });

  ipcMain.handle("pig:browser:screenshot", async () => ({
    data: await browserCaptureScreenshot(),
  }));

  ipcMain.handle("pig:browser:inspectStart", async () => {
    await browserStartInspect();
    return { ok: true as const };
  });

  ipcMain.handle("pig:browser:inspectStop", async () => {
    await browserStopInspect();
    return { ok: true as const };
  });

  ipcMain.handle("pig:browser:zoom", async (_e, action: "in" | "out" | "reset") => {
    await browserPageZoom(action);
    return { ok: true as const };
  });

  ipcMain.handle("pig:browser:toggleDevTools", () => ({ open: browserToggleDevTools() }));

  ipcMain.handle("pig:browser:devToolsOpen", () => ({ open: browserDevToolsOpen() }));

  ipcMain.handle("pig:browser:stop", async () => {
    await browserStop();
    return getBrowserState();
  });
}
