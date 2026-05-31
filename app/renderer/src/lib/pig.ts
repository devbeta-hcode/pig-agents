/**
 * Typed accessor over the preload bridge (`window.pig`).
 * All renderer ↔ main communication goes through here.
 */

export interface StreamHandle {
  close: () => void;
}

export interface TerminalHandle {
  id: string;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
  onData: (cb: (msg: { type: "data" | "exit"; data?: string; exitCode?: number }) => void) => () => void;
}

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

export interface PigBridge {
  rpc<T = unknown>(method: string, args: unknown[]): Promise<T>;
  streamOpen(kind: string, params: unknown, onMessage: (m: any) => void): StreamHandle;
  terminalCreate(params: { cols: number; rows: number; workspace?: string }): Promise<TerminalHandle>;
  pickFolder(): Promise<{ workspace: string }>;

  windowMinimize(): Promise<void>;
  windowMaximize(): Promise<void>;
  windowClose(): Promise<void>;
  windowIsMaximized(): Promise<boolean>;
  onWindowMaximized(cb: (maximized: boolean) => void): () => void;

  zoomGet(): Promise<{ percent: number }>;
  zoomSet(percent: number): Promise<{ percent: number }>;
  zoomStep(delta: number): Promise<{ percent: number }>;

  browserSetVisible(visible: boolean): Promise<BrowserState>;
  browserSetBounds(bounds: { x: number; y: number; width: number; height: number } | null): Promise<{ ok: true }>;
  browserSetOverlaySuppressed(suppressed: boolean): Promise<{ ok: true }>;
  browserSetTabActive(active: boolean): Promise<{ ok: true }>;
  browserRegisterGuest(guestId: number): Promise<BrowserState>;
  browserUnregisterGuest(guestId: number): Promise<{ ok: true }>;
  browserNavigate(url: string): Promise<BrowserState>;
  browserBack(): Promise<BrowserState>;
  browserForward(): Promise<BrowserState>;
  browserReload(): Promise<BrowserState>;
  browserHardReload(): Promise<BrowserState>;
  browserClearData(kind: "history" | "cookies" | "cache"): Promise<{ ok: true }>;
  browserGetState(): Promise<BrowserState>;
  onBrowserState(cb: (state: BrowserState) => void): () => void;
  onBrowserLayout(cb: () => void): () => void;
  onBrowserAgentActivate(cb: () => void): () => void;
  browserFocus(): Promise<{ ok: true }>;
  browserScreenshot(): Promise<{ data: string }>;
  browserInspectStart(): Promise<{ ok: true }>;
  browserInspectStop(): Promise<{ ok: true }>;
  browserZoom(action: "in" | "out" | "reset"): Promise<{ ok: true }>;
  browserToggleDevTools(): Promise<{ open: boolean }>;
  browserDevToolsOpen(): Promise<{ open: boolean }>;
  browserStop(): Promise<BrowserState>;
  onBrowserInspectPick(
    cb: (payload: { element: BrowserElementInfo; screenshot: string }) => void,
  ): () => void;
  onBrowserInspectCancel(cb: () => void): () => void;
  onBrowserDevTools(cb: (open: boolean) => void): () => void;
  onBrowserOverlaySuppressed(cb: (suppressed: boolean) => void): () => void;
}

declare global {
  interface Window {
    pig: PigBridge;
  }
}

export const pig: PigBridge = window.pig;
