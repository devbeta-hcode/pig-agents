import { contextBridge, ipcRenderer } from "electron";

interface StreamHandle {
  close: () => void;
}

interface TerminalHandle {
  id: string;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
  onData: (cb: (msg: { type: "data" | "exit"; data?: string; exitCode?: number }) => void) => () => void;
}

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `s${Date.now().toString(36)}-${idCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

const pig = {
  rpc(method: string, args: unknown[]): Promise<unknown> {
    return ipcRenderer.invoke("pig:rpc", method, args);
  },

  streamOpen(kind: string, params: unknown, onMessage: (m: unknown) => void): StreamHandle {
    const streamId = nextId();
    const channel = `pig:stream:${streamId}`;
    const listener = (_e: Electron.IpcRendererEvent, msg: unknown) => onMessage(msg);
    ipcRenderer.on(channel, listener);
    void ipcRenderer.invoke("pig:stream:open", { streamId, kind, params });
    return {
      close() {
        ipcRenderer.removeListener(channel, listener);
        void ipcRenderer.invoke("pig:stream:close", { streamId });
      },
    };
  },

  async terminalCreate(params: { cols: number; rows: number; workspace?: string }): Promise<TerminalHandle> {
    const { id } = (await ipcRenderer.invoke("pig:terminal:create", params)) as { id: string };
    const channel = `pig:terminal:${id}`;
    return {
      id,
      write: (data) => ipcRenderer.send("pig:terminal:write", { id, data }),
      resize: (cols, rows) => ipcRenderer.send("pig:terminal:resize", { id, cols, rows }),
      kill: () => ipcRenderer.send("pig:terminal:kill", { id }),
      onData: (cb) => {
        const listener = (_e: Electron.IpcRendererEvent, msg: { type: "data" | "exit"; data?: string; exitCode?: number }) => cb(msg);
        ipcRenderer.on(channel, listener);
        return () => ipcRenderer.removeListener(channel, listener);
      },
    };
  },

  pickFolder(): Promise<{ workspace: string }> {
    return ipcRenderer.invoke("pig:workspace:pickFolder") as Promise<{ workspace: string }>;
  },

  windowMinimize(): Promise<void> {
    return ipcRenderer.invoke("pig:window:minimize");
  },
  windowMaximize(): Promise<void> {
    return ipcRenderer.invoke("pig:window:maximize");
  },
  windowClose(): Promise<void> {
    return ipcRenderer.invoke("pig:window:close");
  },
  windowIsMaximized(): Promise<boolean> {
    return ipcRenderer.invoke("pig:window:isMaximized") as Promise<boolean>;
  },
  onWindowMaximized(cb: (maximized: boolean) => void): () => void {
    const listener = (_e: Electron.IpcRendererEvent, value: boolean) => cb(value);
    ipcRenderer.on("pig:window:maximized", listener);
    return () => ipcRenderer.removeListener("pig:window:maximized", listener);
  },

  zoomGet(): Promise<{ percent: number }> {
    return ipcRenderer.invoke("pig:zoom:get") as Promise<{ percent: number }>;
  },
  zoomSet(percent: number): Promise<{ percent: number }> {
    return ipcRenderer.invoke("pig:zoom:set", percent) as Promise<{ percent: number }>;
  },
  zoomStep(delta: number): Promise<{ percent: number }> {
    return ipcRenderer.invoke("pig:zoom:step", delta) as Promise<{ percent: number }>;
  },

  clipboardRead(): Promise<string> {
    return ipcRenderer.invoke("pig:clipboard:read") as Promise<string>;
  },
  clipboardWrite(text: string): Promise<void> {
    return ipcRenderer.invoke("pig:clipboard:write", text) as Promise<void>;
  },

  browserSetVisible(visible: boolean) {
    return ipcRenderer.invoke("pig:browser:setVisible", visible) as Promise<BrowserStatePayload>;
  },
  browserSetBounds(bounds: { x: number; y: number; width: number; height: number } | null) {
    return ipcRenderer.invoke("pig:browser:setBounds", bounds) as Promise<{ ok: true }>;
  },
  browserSetOverlaySuppressed(suppressed: boolean) {
    return ipcRenderer.invoke("pig:browser:setOverlaySuppressed", suppressed) as Promise<{ ok: true }>;
  },
  browserSetTabActive(active: boolean) {
    return ipcRenderer.invoke("pig:browser:setTabActive", active) as Promise<{ ok: true }>;
  },
  browserRegisterGuest(guestId: number) {
    return ipcRenderer.invoke("pig:browser:registerGuest", guestId) as Promise<BrowserStatePayload>;
  },
  browserUnregisterGuest(guestId: number) {
    return ipcRenderer.invoke("pig:browser:unregisterGuest", guestId) as Promise<{ ok: true }>;
  },
  browserNavigate(url: string) {
    return ipcRenderer.invoke("pig:browser:navigate", url) as Promise<BrowserStatePayload>;
  },
  browserBack() {
    return ipcRenderer.invoke("pig:browser:back") as Promise<BrowserStatePayload>;
  },
  browserForward() {
    return ipcRenderer.invoke("pig:browser:forward") as Promise<BrowserStatePayload>;
  },
  browserReload() {
    return ipcRenderer.invoke("pig:browser:reload") as Promise<BrowserStatePayload>;
  },
  browserHardReload() {
    return ipcRenderer.invoke("pig:browser:hardReload") as Promise<BrowserStatePayload>;
  },
  browserClearData(kind: "history" | "cookies" | "cache") {
    return ipcRenderer.invoke("pig:browser:clearData", kind) as Promise<{ ok: true }>;
  },
  browserGetState() {
    return ipcRenderer.invoke("pig:browser:getState") as Promise<BrowserStatePayload>;
  },
  onBrowserState(cb: (state: BrowserStatePayload) => void): () => void {
    const listener = (_e: Electron.IpcRendererEvent, state: BrowserStatePayload) => cb(state);
    ipcRenderer.on("pig:browser:state", listener);
    return () => ipcRenderer.removeListener("pig:browser:state", listener);
  },
  onBrowserLayout(cb: () => void): () => void {
    const listener = () => cb();
    ipcRenderer.on("pig:browser:layout", listener);
    return () => ipcRenderer.removeListener("pig:browser:layout", listener);
  },
  onBrowserAgentActivate(cb: () => void): () => void {
    const listener = () => cb();
    ipcRenderer.on("pig:browser:agentActivate", listener);
    return () => ipcRenderer.removeListener("pig:browser:agentActivate", listener);
  },
  browserFocus() {
    return ipcRenderer.invoke("pig:browser:focus") as Promise<{ ok: true }>;
  },
  browserScreenshot() {
    return ipcRenderer.invoke("pig:browser:screenshot") as Promise<{ data: string }>;
  },
  browserInspectStart() {
    return ipcRenderer.invoke("pig:browser:inspectStart") as Promise<{ ok: true }>;
  },
  browserInspectStop() {
    return ipcRenderer.invoke("pig:browser:inspectStop") as Promise<{ ok: true }>;
  },
  browserZoom(action: "in" | "out" | "reset") {
    return ipcRenderer.invoke("pig:browser:zoom", action) as Promise<{ ok: true }>;
  },
  browserToggleDevTools() {
    return ipcRenderer.invoke("pig:browser:toggleDevTools") as Promise<{ open: boolean }>;
  },
  browserDevToolsOpen() {
    return ipcRenderer.invoke("pig:browser:devToolsOpen") as Promise<{ open: boolean }>;
  },
  browserStop() {
    return ipcRenderer.invoke("pig:browser:stop") as Promise<BrowserStatePayload>;
  },
  onBrowserInspectPick(
    cb: (payload: { element: BrowserElementPayload; screenshot: string }) => void,
  ): () => void {
    const listener = (
      _e: Electron.IpcRendererEvent,
      payload: { element: BrowserElementPayload; screenshot: string },
    ) => cb(payload);
    ipcRenderer.on("pig:browser:inspectPick", listener);
    return () => ipcRenderer.removeListener("pig:browser:inspectPick", listener);
  },
  onBrowserInspectCancel(cb: () => void): () => void {
    const listener = () => cb();
    ipcRenderer.on("pig:browser:inspectCancel", listener);
    return () => ipcRenderer.removeListener("pig:browser:inspectCancel", listener);
  },
  onBrowserDevTools(cb: (open: boolean) => void): () => void {
    const listener = (_e: Electron.IpcRendererEvent, open: boolean) => cb(open);
    ipcRenderer.on("pig:browser:devTools", listener);
    return () => ipcRenderer.removeListener("pig:browser:devTools", listener);
  },
  onBrowserOverlaySuppressed(cb: (suppressed: boolean) => void): () => void {
    const listener = (_e: Electron.IpcRendererEvent, suppressed: boolean) => cb(suppressed);
    ipcRenderer.on("pig:browser:overlaySuppressed", listener);
    return () => ipcRenderer.removeListener("pig:browser:overlaySuppressed", listener);
  },
};

export interface BrowserStatePayload {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface BrowserElementPayload {
  outerHTML: string;
  path: string;
  attributes: Record<string, string>;
  textContent: string;
  rect: { top: number; left: number; width: number; height: number };
  computedStyles: Record<string, string>;
}

contextBridge.exposeInMainWorld("pig", pig);
