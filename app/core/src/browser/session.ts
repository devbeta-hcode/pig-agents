/**
 * Desktop browser session — delegates to the registered BrowserDriver
 * (Electron BrowserView in the desktop app).
 */
import { EventEmitter } from "node:events";
import { getBrowserDriver, requireBrowserDriver } from "./driver.js";

export interface ElementInfo {
  outerHTML: string;
  path: string;
  attributes: Record<string, string>;
  textContent: string;
  rect: { top: number; left: number; width: number; height: number };
  computedStyles: Record<string, string>;
}

export class BrowserSession extends EventEmitter {
  isPlaywrightReady(): Promise<boolean> {
    return Promise.resolve(!!getBrowserDriver());
  }

  isStarted(): boolean {
    return getBrowserDriver()?.isStarted() ?? false;
  }

  hasPageLoaded(): boolean {
    return getBrowserDriver()?.hasPageLoaded() ?? false;
  }

  currentUrl(): string {
    return getBrowserDriver()?.currentUrl() ?? "";
  }

  installPlaywright(): void {
    this.emit("event", {
      type: "install_done",
      success: true,
      message: "Desktop uses native Electron BrowserView (no Playwright install).",
    });
  }

  ensureStarted(): Promise<void> {
    return requireBrowserDriver().ensureStarted();
  }

  start(): Promise<void> {
    return this.ensureStarted();
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }

  navigate(url: string): Promise<void> {
    return requireBrowserDriver().navigate(url);
  }

  goBack(): Promise<void> {
    return requireBrowserDriver().goBack();
  }

  goForward(): Promise<void> {
    return requireBrowserDriver().goForward();
  }

  reload(): Promise<void> {
    return requireBrowserDriver().reload();
  }

  getTitle(): Promise<string> {
    return requireBrowserDriver().getTitle();
  }

  getPageText(sel?: string, cap?: number): Promise<string> {
    return requireBrowserDriver().getPageText(sel, cap);
  }

  getPageHTML(sel?: string, cap?: number): Promise<string> {
    return requireBrowserDriver().getPageHTML(sel, cap);
  }

  clickSelector(sel: string, timeoutMs?: number): Promise<void> {
    return requireBrowserDriver().clickSelector(sel, timeoutMs);
  }

  fillSelector(sel: string, value: string, timeoutMs?: number): Promise<void> {
    return requireBrowserDriver().fillSelector(sel, value, timeoutMs);
  }

  waitForSelector(sel: string, state: string, timeoutMs: number): Promise<void> {
    return requireBrowserDriver().waitForSelector(sel, state, timeoutMs);
  }

  evalScript(js: string): Promise<unknown> {
    return requireBrowserDriver().evalScript(js);
  }

  clickAt(x: number, y: number): Promise<ElementInfo | null> {
    return requireBrowserDriver().clickAt(x, y);
  }

  getElementAt(x: number, y: number): Promise<ElementInfo | null> {
    return requireBrowserDriver().getElementAt(x, y);
  }

  typeText(text: string): Promise<void> {
    return requireBrowserDriver().typeText(text);
  }

  keyPress(key: string): Promise<void> {
    return requireBrowserDriver().keyPress(key);
  }

  scroll(_x: number, _y: number, dx: number, dy: number): Promise<void> {
    return requireBrowserDriver().scroll(_x, _y, dx, dy);
  }

  hover(_x: number, _y: number): Promise<{ label: string; cursor: string }> {
    return Promise.resolve({ label: "", cursor: "default" });
  }

  mouseMove(_x: number, _y: number): Promise<void> {
    return Promise.resolve();
  }

  setViewport(_w: number, _h: number, _dpr: number): Promise<void> {
    return Promise.resolve();
  }

  getViewport(): { width: number; height: number; dpr: number } {
    return { width: 1280, height: 800, dpr: 1 };
  }

  takeScreenshot(): Promise<string> {
    return Promise.reject(new Error("browser screenshot not implemented for BrowserView yet"));
  }

  inspectElement(
    x: number,
    y: number,
  ): Promise<{ element: ElementInfo; screenshot: string } | null> {
    return this.getElementAt(x, y).then((el) => (el ? { element: el, screenshot: "" } : null));
  }
}

export const browserSession = new BrowserSession();
