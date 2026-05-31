import type { BrowserDriver, ElementInfo } from "@pig-agents/core";
import {
  browserClickAt,
  browserClickSelector,
  browserCurrentUrl,
  browserEnsureForAgent,
  browserEval,
  browserFillSelector,
  browserGetElementAt,
  browserGetPageHTML,
  browserGetPageText,
  browserGetTitle,
  browserGoBack,
  browserGoForward,
  browserHasPageLoaded,
  browserIsStarted,
  browserKeyPress,
  browserNavigate,
  browserReload,
  browserScroll,
  browserTypeText,
  browserWaitForSelector,
  setBrowserBounds,
  setBrowserVisible,
} from "./controller.js";

export function createElectronBrowserDriver(): BrowserDriver {
  return {
    async ensureStarted() {
      await browserEnsureForAgent();
    },
    isStarted() {
      return browserIsStarted();
    },
    hasPageLoaded() {
      return browserHasPageLoaded();
    },
    currentUrl() {
      return browserCurrentUrl();
    },
    navigate(url) {
      return browserNavigate(url);
    },
    goBack() {
      return browserGoBack();
    },
    goForward() {
      return browserGoForward();
    },
    reload() {
      return browserReload();
    },
    getTitle() {
      return browserGetTitle();
    },
    getPageText(sel, cap) {
      return browserGetPageText(sel, cap);
    },
    getPageHTML(sel, cap) {
      return browserGetPageHTML(sel, cap);
    },
    clickSelector(sel, timeoutMs) {
      return browserClickSelector(sel, timeoutMs);
    },
    fillSelector(sel, value, timeoutMs) {
      return browserFillSelector(sel, value, timeoutMs);
    },
    waitForSelector(sel, state, timeoutMs) {
      return browserWaitForSelector(sel, state, timeoutMs);
    },
    evalScript(js) {
      return browserEval(js);
    },
    clickAt(x, y) {
      return browserClickAt(x, y) as Promise<ElementInfo | null>;
    },
    getElementAt(x, y) {
      return browserGetElementAt(x, y) as Promise<ElementInfo | null>;
    },
    typeText(text) {
      return browserTypeText(text);
    },
    keyPress(key) {
      return browserKeyPress(key);
    },
    scroll(x, y, dx, dy) {
      return browserScroll(x, y, dx, dy);
    },
    setVisible(visible) {
      setBrowserVisible(visible);
    },
    setBounds(bounds) {
      setBrowserBounds(bounds);
    },
  };
}
