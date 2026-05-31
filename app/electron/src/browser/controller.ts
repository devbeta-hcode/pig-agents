/**
 * Embedded page — guest `<webview>` in the Browser panel (DOM-aligned, no BrowserView bounds).
 */
import { webContents, type BrowserWindow, type Rectangle, type WebContents } from "electron";
import { logger as log } from "@pig-agents/core";
import {
  detachCdp,
  fillViaPointer,
  keyViaCdp,
  pointerClick,
  typeViaCdp,
} from "./cdpInput.js";
import {
  INSPECT_CANCEL_MSG,
  INSPECT_OVERLAY_SCRIPT,
  INSPECT_OVERLAY_STOP_SCRIPT,
  INSPECT_PICK_PREFIX,
} from "./inspectOverlay.js";

export interface BrowserState {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface BrowserElementInfo {
  outerHTML: string;
  path: string;
  attributes: Record<string, string>;
  textContent: string;
  rect: { top: number; left: number; width: number; height: number };
  computedStyles: Record<string, string>;
}

type GetWindow = () => BrowserWindow | null;

let getWindow: GetWindow = () => null;
let guestWc: WebContents | null = null;
let uiVisible = false;
let overlaySuppressed = false;
let started = false;
let inspectModeWanted = false;

function wc(): WebContents | null {
  if (!guestWc || guestWc.isDestroyed()) return null;
  return guestWc;
}

function notifyDevTools(open: boolean): void {
  const win = getWindow();
  if (!win || win.isDestroyed()) return;
  win.webContents.send("pig:browser:devTools", open);
}

function notifyOverlaySuppressed(suppressed: boolean): void {
  const win = getWindow();
  if (!win || win.isDestroyed()) return;
  win.webContents.send("pig:browser:overlaySuppressed", suppressed);
}

function notifyRenderer(state: Partial<BrowserState> = {}): void {
  const win = getWindow();
  if (!win || win.isDestroyed()) return;
  const contents = wc();
  const payload: BrowserState = {
    url: state.url ?? contents?.getURL() ?? "",
    title: state.title ?? (contents?.getTitle() || ""),
    loading: state.loading ?? (contents?.isLoading() ?? false),
    canGoBack: state.canGoBack ?? (contents?.navigationHistory.canGoBack() ?? false),
    canGoForward: state.canGoForward ?? (contents?.navigationHistory.canGoForward() ?? false),
  };
  win.webContents.send("pig:browser:state", payload);
}

function notifyAgentActivate(): void {
  const win = getWindow();
  if (!win || win.isDestroyed()) return;
  win.webContents.send("pig:browser:agentActivate");
}

function requireGuest(): WebContents {
  const contents = wc();
  if (!contents) throw new Error("Browser panel not open — open the Browser tab first");
  return contents;
}

function wireWebContentsEvents(contents: WebContents): void {
  if ((contents as { __pigBrowserWired?: boolean }).__pigBrowserWired) return;
  (contents as { __pigBrowserWired?: boolean }).__pigBrowserWired = true;

  contents.on("did-start-loading", () => notifyRenderer({ loading: true }));
  contents.on("did-stop-loading", () => {
    notifyRenderer({ loading: false });
    if (inspectModeWanted) void mountInspectOverlay();
  });
  contents.on("did-navigate", () => notifyRenderer());
  contents.on("did-navigate-in-page", () => notifyRenderer());
  contents.on("page-title-updated", (_e, title) => notifyRenderer({ title }));
  contents.setWindowOpenHandler(({ url }) => {
    void contents.loadURL(url);
    return { action: "deny" };
  });
  contents.on("devtools-opened", () => notifyDevTools(true));
  contents.on("devtools-closed", () => notifyDevTools(false));
  wireInspectConsole(contents);
}

function wireInspectConsole(contents: WebContents): void {
  if ((contents as { __pigInspectConsole?: boolean }).__pigInspectConsole) return;
  (contents as { __pigInspectConsole?: boolean }).__pigInspectConsole = true;

  contents.on("console-message", (_event, _level, message) => {
    if (message.startsWith(INSPECT_PICK_PREFIX)) {
      try {
        const element = JSON.parse(message.slice(INSPECT_PICK_PREFIX.length)) as BrowserElementInfo;
        void handleInspectPick(element);
      } catch (err) {
        log.warn("inspect pick parse failed", err);
      }
      return;
    }
    if (message === INSPECT_CANCEL_MSG) {
      getWindow()?.webContents.send("pig:browser:inspectCancel");
      void browserStopInspect();
    }
  });
}

async function handleInspectPick(element: BrowserElementInfo): Promise<void> {
  let screenshot = "";
  try {
    const r = element.rect;
    screenshot = await browserCaptureScreenshot({
      x: Math.max(0, Math.round(r.left)),
      y: Math.max(0, Math.round(r.top)),
      width: Math.max(1, Math.round(r.width)),
      height: Math.max(1, Math.round(r.height)),
    });
  } catch {
    try {
      screenshot = await browserCaptureScreenshot();
    } catch { /* non-fatal */ }
  }
  const win = getWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send("pig:browser:inspectPick", { element, screenshot });
  }
  if (inspectModeWanted) void mountInspectOverlay();
}

export function initBrowserController(getWin: GetWindow): void {
  getWindow = getWin;
}

/** Called when the panel `<webview>` fires dom-ready. */
export function registerBrowserGuest(guestId: number): void {
  const guest = webContents.fromId(guestId);
  if (!guest || guest.isDestroyed()) {
    throw new Error(`Browser guest webContents ${guestId} not found`);
  }
  guestWc = guest;
  wireWebContentsEvents(guest);
  started = true;
  log.info("Browser webview registered", { guestId });
  notifyRenderer();
}

export function unregisterBrowserGuest(guestId: number): void {
  if (guestWc?.id === guestId) {
    detachCdp(guestWc);
    guestWc = null;
    started = false;
  }
}

export function setBrowserVisible(visible: boolean): void {
  uiVisible = visible;
  notifyRenderer();
}

/** Legacy IPC — bounds unused with `<webview>` (DOM-aligned). */
export function setBrowserBounds(_bounds: Rectangle | null): void {
  /* no-op */
}

export function setBrowserTabActive(_active: boolean): void {
  /* no-op — tab visibility is handled by React mount/unmount */
}

export function setBrowserOverlaySuppressed(suppressed: boolean): void {
  if (overlaySuppressed === suppressed) return;
  overlaySuppressed = suppressed;
  if (suppressed) {
    const contents = wc();
    if (contents) {
      void contents.executeJavaScript(INSPECT_OVERLAY_STOP_SCRIPT, true).catch(() => {});
    }
  } else if (inspectModeWanted) {
    void mountInspectOverlay();
  }
  notifyOverlaySuppressed(suppressed);
}

export function browserIsStarted(): boolean {
  return started && !!wc();
}

export function browserHasPageLoaded(): boolean {
  if (!started || !wc()) return false;
  const url = wc()?.getURL() ?? "";
  return url.length > 0 && url !== "about:blank";
}

/** Agent browser_* tools — open Browser tab and wait for `<webview>` registration. */
export async function browserEnsureForAgent(): Promise<void> {
  notifyAgentActivate();
  setBrowserVisible(true);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (wc()) return;
    await sleep(50);
  }
  throw new Error("Browser panel did not register — open the Browser tab");
}

export function browserCurrentUrl(): string {
  return wc()?.getURL() ?? "";
}

function normalizeUrl(url: string): string {
  let u = url.trim();
  if (!u) return "about:blank";
  const embedded = u.match(/https?:\/\/[^\s<>"']+/i);
  if (embedded) u = embedded[0];
  if (/^https?:\/\//i.test(u) || u.startsWith("about:") || u.startsWith("file:")) return u;
  return `https://${u}`;
}

export async function browserNavigate(url: string): Promise<void> {
  const contents = requireGuest();
  const target = normalizeUrl(url);
  await new Promise<void>((resolve, reject) => {
    const onFinish = () => {
      cleanup();
      resolve();
    };
    const onFail = (_event: unknown, code: number, desc: string) => {
      cleanup();
      reject(new Error(`Navigation failed (${code}): ${desc}`));
    };
    const cleanup = () => {
      contents.removeListener("did-finish-load", onFinish);
      contents.removeListener("did-fail-load", onFail);
    };
    contents.once("did-finish-load", onFinish);
    contents.once("did-fail-load", onFail);
    void contents.loadURL(target).catch((err) => {
      cleanup();
      reject(err);
    });
  });
  browserFocus();
  notifyRenderer();
}

export async function browserGoBack(): Promise<void> {
  const contents = wc();
  if (contents?.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
}

export async function browserGoForward(): Promise<void> {
  const contents = wc();
  if (contents?.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
}

export async function browserReload(): Promise<void> {
  wc()?.reload();
}

export async function browserHardReload(): Promise<void> {
  const contents = wc();
  if (!contents || contents.isDestroyed()) return;
  contents.reloadIgnoringCache();
}

export async function browserClearBrowsingData(
  kind: "history" | "cookies" | "cache",
): Promise<void> {
  const contents = wc();
  if (!contents || contents.isDestroyed()) return;
  const ses = contents.session;
  if (kind === "cache") {
    await ses.clearCache();
    return;
  }
  if (kind === "cookies") {
    await ses.clearStorageData({ storages: ["cookies"] });
    return;
  }
  try {
    contents.navigationHistory.clear();
  } catch {
    /* navigationHistory.clear unavailable on older Electron */
  }
  await ses.clearStorageData({
    storages: ["localstorage", "indexdb", "cachestorage", "serviceworkers", "websql"],
  });
}

export async function browserGetTitle(): Promise<string> {
  return wc()?.getTitle() || "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function browserEval<T>(js: string): Promise<T> {
  const contents = requireGuest();
  return contents.executeJavaScript(js, true) as Promise<T>;
}

async function elementCenterFromSelector(
  selector: string,
  timeoutMs: number,
): Promise<{ x: number; y: number }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pt = await browserEval<{ x: number; y: number } | null>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "center" });
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return null;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (pt) return pt;
    await sleep(80);
  }
  throw new Error(`selector not found: ${selector}`);
}

export async function browserClickSelector(selector: string, timeoutMs = 10_000): Promise<void> {
  const contents = requireGuest();
  const pt = await elementCenterFromSelector(selector, timeoutMs);
  await pointerClick(contents, pt.x, pt.y);
}

export async function browserFillSelector(selector: string, value: string, timeoutMs = 10_000): Promise<void> {
  const contents = requireGuest();
  const pt = await elementCenterFromSelector(selector, timeoutMs);
  await fillViaPointer(contents, pt.x, pt.y, value);
}

export async function browserGetPageText(selector?: string, maxChars = 12_000): Promise<string> {
  const cap = Math.max(500, Math.min(50_000, maxChars));
  const js = selector
    ? `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return ""; return (el.innerText || el.textContent || "").slice(0, ${cap}); })()`
    : `(() => (document.body?.innerText || document.body?.textContent || "").slice(0, ${cap}))()`;
  return String(await browserEval(js));
}

export async function browserGetPageHTML(selector?: string, maxChars = 20_000): Promise<string> {
  const cap = Math.max(500, Math.min(60_000, maxChars));
  const js = selector
    ? `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return ""; return (el.outerHTML || "").slice(0, ${cap}); })()`
    : `(() => (document.documentElement?.outerHTML || "").slice(0, ${cap}))()`;
  return String(await browserEval(js));
}

export async function browserWaitForSelector(
  selector: string,
  state: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const st = state === "attached" || state === "hidden" ? state : "visible";
  const sel = JSON.stringify(selector);
  const checkJs =
    st === "hidden"
      ? `!document.querySelector(${sel})`
      : st === "attached"
        ? `!!document.querySelector(${sel})`
        : `(() => { const el = document.querySelector(${sel}); if (!el) return false; const h = el; return h.offsetParent !== null || h === document.body; })()`;
  while (Date.now() < deadline) {
    if (await browserEval<boolean>(checkJs)) return;
    await sleep(100);
  }
  throw new Error(`waitForSelector timeout (${selector}, ${state})`);
}

export async function browserGetElementAt(x: number, y: number): Promise<{
  outerHTML: string;
  path: string;
  attributes: Record<string, string>;
  textContent: string;
  rect: { top: number; left: number; width: number; height: number };
  computedStyles: Record<string, string>;
} | null> {
  return browserEval(`(() => {
    const el = document.elementFromPoint(${x}, ${y});
    if (!el || !(el instanceof Element)) return null;
    const rect = el.getBoundingClientRect();
    const attrs = {};
    for (const a of el.attributes) attrs[a.name] = a.value;
    const cs = getComputedStyle(el);
    const styles = { color: cs.color, background: cs.backgroundColor, fontSize: cs.fontSize };
    let path = el.tagName.toLowerCase();
    if (el.id) path += "#" + el.id;
    return {
      outerHTML: String(el.outerHTML || "").slice(0, 2000),
      path,
      attributes: attrs,
      textContent: (el.textContent || "").slice(0, 500),
      rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
      computedStyles: styles,
    };
  })()`);
}

export async function browserClickAt(x: number, y: number) {
  const contents = requireGuest();
  await pointerClick(contents, x, y);
  return browserGetElementAt(x, y);
}

export async function browserTypeText(text: string): Promise<void> {
  const contents = requireGuest();
  await typeViaCdp(contents, text);
}

export async function browserKeyPress(key: string): Promise<void> {
  const contents = requireGuest();
  await keyViaCdp(contents, key);
}

export async function browserScroll(_x: number, _y: number, dx: number, dy: number): Promise<void> {
  await browserEval(`window.scrollBy(${dx}, ${dy})`);
}

export function getBrowserState(): BrowserState {
  const contents = wc();
  return {
    url: contents?.getURL() ?? "",
    title: contents?.getTitle() || "",
    loading: contents?.isLoading() ?? false,
    canGoBack: contents?.navigationHistory.canGoBack() ?? false,
    canGoForward: contents?.navigationHistory.canGoForward() ?? false,
  };
}

export function browserFocus(): void {
  wc()?.focus();
}

export async function browserCaptureScreenshot(clip?: Rectangle): Promise<string> {
  const contents = wc();
  if (!contents) throw new Error("Browser not started");
  const image =
    clip && clip.width > 0 && clip.height > 0
      ? await contents.capturePage(clip)
      : await contents.capturePage();
  return image.toPNG().toString("base64");
}

export function browserToggleDevTools(): boolean {
  const contents = wc();
  if (!contents || contents.isDestroyed()) return false;
  if (contents.isDevToolsOpened()) {
    contents.closeDevTools();
    return false;
  }
  contents.openDevTools({ mode: "detach" });
  return true;
}

export function browserDevToolsOpen(): boolean {
  const contents = wc();
  return !!contents && !contents.isDestroyed() && contents.isDevToolsOpened();
}

export async function browserPageZoom(action: "in" | "out" | "reset"): Promise<void> {
  if (action === "reset") {
    await browserEval(`document.body.style.zoom = "1"`);
    return;
  }
  const delta = action === "in" ? 0.1 : -0.1;
  await browserEval(`(() => {
    const cur = parseFloat(document.body.style.zoom || "1") || 1;
    const next = Math.max(0.3, Math.min(3, cur + ${delta}));
    document.body.style.zoom = next.toFixed(1);
  })()`);
}

async function mountInspectOverlay(): Promise<void> {
  const contents = wc();
  if (!contents) return;
  try {
    await contents.executeJavaScript(INSPECT_OVERLAY_STOP_SCRIPT, true);
  } catch { /* noop */ }
  await browserEval(INSPECT_OVERLAY_SCRIPT);
}

export async function browserStartInspect(): Promise<void> {
  inspectModeWanted = true;
  browserFocus();
  await mountInspectOverlay();
}

export async function browserStopInspect(): Promise<void> {
  inspectModeWanted = false;
  const contents = wc();
  if (!contents) return;
  try {
    await contents.executeJavaScript(INSPECT_OVERLAY_STOP_SCRIPT, true);
  } catch { /* page may be navigating */ }
}

export async function browserStop(): Promise<void> {
  await browserStopInspect();
  setBrowserVisible(false);
  const contents = wc();
  if (contents && !contents.isDestroyed()) {
    detachCdp(contents);
    if (contents.isDevToolsOpened()) contents.closeDevTools();
    try {
      await contents.loadURL("about:blank");
    } catch { /* noop */ }
  }
}
