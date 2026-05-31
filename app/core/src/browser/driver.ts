/**
 * Pluggable browser backend for desktop (Electron BrowserView) vs future targets.
 * Electron main registers an implementation at startup.
 */

import type { ElementInfo } from "./session.js";

export interface BrowserDriver {
  ensureStarted(): Promise<void>;
  isStarted(): boolean;
  hasPageLoaded(): boolean;
  currentUrl(): string;
  navigate(url: string): Promise<void>;
  goBack(): Promise<void>;
  goForward(): Promise<void>;
  reload(): Promise<void>;
  getTitle(): Promise<string>;
  getPageText(selector?: string, maxChars?: number): Promise<string>;
  getPageHTML(selector?: string, maxChars?: number): Promise<string>;
  clickSelector(selector: string, timeoutMs?: number): Promise<void>;
  fillSelector(selector: string, value: string, timeoutMs?: number): Promise<void>;
  waitForSelector(selector: string, state: string, timeoutMs: number): Promise<void>;
  evalScript(js: string): Promise<unknown>;
  clickAt(x: number, y: number): Promise<ElementInfo | null>;
  getElementAt(x: number, y: number): Promise<ElementInfo | null>;
  typeText(text: string): Promise<void>;
  keyPress(key: string): Promise<void>;
  scroll(x: number, y: number, dx: number, dy: number): Promise<void>;
  setVisible(visible: boolean): void;
  setBounds(bounds: { x: number; y: number; width: number; height: number } | null): void;
}

let driver: BrowserDriver | null = null;

export function setBrowserDriver(impl: BrowserDriver | null): void {
  driver = impl;
}

export function getBrowserDriver(): BrowserDriver | null {
  return driver;
}

export function requireBrowserDriver(): BrowserDriver {
  if (!driver) {
    throw new Error(
      "Embedded browser is not initialized (Electron BrowserView driver not registered).",
    );
  }
  return driver;
}
