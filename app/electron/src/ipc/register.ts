import path from "node:path";
import { randomUUID } from "node:crypto";
import { app, ipcMain, dialog, clipboard, type BrowserWindow, type OpenDialogOptions, type WebContents } from "electron";
import { getUiZoomPercent, setUiZoomPercent, stepUiZoomPercent } from "../uiPrefs.js";
import { applyWindowZoom } from "../zoom.js";
import { registerBrowser } from "../browser/register.js";
import {
  services,
  runAgent,
  subscribeToSession,
  getSession,
  subscribeAgentCommands,
  listAgentCommands,
  listLiveAgentCommands,
  workspaceWatcher,
  getWorkspace,
  setWorkspace,
  validateWorkspacePath,
  createPty,
  setBeforeDeletePathHook,
  logger,
  type PtyLike,
  type WorkspaceChangesPayload,
} from "@pig-agents/core";

type Send = (msg: unknown) => void;

type TerminalEntry = { pty: PtyLike; cwd: string };

// Global map to track active PTY instances so we can clean them up gracefully on app quit.
const terminals = new Map<string, TerminalEntry>();

/** Kill PTY only when delete removes the shell's cwd or a parent directory — not sibling files. */
function terminalTouchesPath(termCwd: string, targetAbs: string): boolean {
  const cwd = path.resolve(termCwd);
  const target = path.resolve(targetAbs);
  if (cwd === target) return true;
  const sep = path.sep;
  return cwd.startsWith(target + sep);
}

/** Kill UI terminal tabs that may hold dev servers locking files under `targetAbs`. */
export function killTerminalsUnderPath(targetAbs: string): number {
  let n = 0;
  for (const [id, entry] of terminals) {
    if (!terminalTouchesPath(entry.cwd, targetAbs)) continue;
    try {
      entry.pty.kill();
      n++;
    } catch { /* noop */ }
    terminals.delete(id);
  }
  return n;
}

export function cleanupTerminals(): void {
  for (const entry of terminals.values()) {
    try { entry.pty.kill(); } catch { /* noop */ }
  }
  terminals.clear();
}

/** Wire one streaming subscription. Returns a cleanup function. */
function startStream(kind: string, params: Record<string, any>, send: Send): () => void {
  switch (kind) {
    case "agentRun": {
      const ac = new AbortController();
      send({ type: "run_started", runId: params.runId });
      runAgent({
        task: String(params.task ?? ""),
        mode: params.mode === "ask" ? "ask" : "agent",
        runId: params.runId,
        signal: ac.signal,
        onEvent: (e) => send(e),
      })
        .then((r) => send({ type: "done", iterations: r.iterations, result: r.result, diffs: r.diffs, runId: params.runId }))
        .catch((err) => {
          const e = err as Error & { __emitted?: boolean };
          if (e.message !== "aborted" && !e.__emitted) send({ type: "error", message: e.message });
        });
      return () => ac.abort();
    }

    case "session": {
      const session = getSession(String(params.sessionId));
      if (!session) {
        send({ type: "error", message: "session not found" });
        return () => {};
      }
      send({
        type: "session_info",
        id: session.id,
        task: session.task,
        mode: session.mode,
        status: session.status,
        createdAt: session.createdAt,
        completedAt: session.completedAt,
        eventCount: session.events.length,
      });
      const unsub = subscribeToSession(
        String(params.sessionId),
        (event) => send(event),
        true,
        (end) => send({ type: "session_ended", ...end }),
      );
      if (!unsub) {
        send({ type: "error", message: "failed to subscribe to session" });
        return () => {};
      }
      return () => unsub();
    }

    case "commandLog": {
      send({ kind: "hello", runs: listAgentCommands(), live: listLiveAgentCommands() });
      const unsub = subscribeAgentCommands(
        (run) => send({ kind: "run", run }),
        () => send({ kind: "clear" }),
        (id) => send({ kind: "delete", id }),
        (info) => send({ kind: "run_start", info }),
        (chunk) => send({ kind: "run_chunk", chunk }),
      );
      return () => unsub();
    }

    case "fsWatch": {
      const root = params.workspace && String(params.workspace).trim() ? String(params.workspace).trim() : getWorkspace();
      const resolved = path.resolve(root);
      const release = workspaceWatcher.ensureWatching(resolved);
      const onChanges = (payload: WorkspaceChangesPayload) => {
        if (path.resolve(payload.workspace) === resolved) send({ type: "fs:changes", changes: payload.changes });
      };
      workspaceWatcher.on("changes", onChanges);
      return () => {
        workspaceWatcher.off("changes", onChanges);
        release();
      };
    }

    default:
      send({ type: "error", message: `unknown stream kind: ${kind}` });
      return () => {};
  }
}

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  setBeforeDeletePathHook((targetAbs) => {
    killTerminalsUnderPath(targetAbs);
  });
  registerBrowser(getWindow);

  // ---- Request/response RPC ------------------------------------------------
  ipcMain.handle("pig:rpc", async (_e, method: string, args: unknown[]) => {
    if (method === "health") return { ok: true as const, ts: Date.now() };
    const fn = (services as Record<string, unknown>)[method];
    if (typeof fn !== "function") throw new Error(`unknown method: ${method}`);
    return await (fn as (...a: unknown[]) => unknown)(...(Array.isArray(args) ? args : []));
  });

  // ---- Streaming subscriptions ---------------------------------------------
  const streams = new Map<string, () => void>();

  ipcMain.handle("pig:stream:open", (e, payload: { streamId: string; kind: string; params?: Record<string, unknown> }) => {
    const { streamId, kind, params } = payload;
    const sender = e.sender;
    const send: Send = (msg) => {
      if (!sender.isDestroyed()) sender.send(`pig:stream:${streamId}`, msg);
    };
    const cleanup = startStream(kind, (params ?? {}) as Record<string, any>, send);
    streams.set(streamId, cleanup);
    return { ok: true as const };
  });

  ipcMain.handle("pig:stream:close", (_e, { streamId }: { streamId: string }) => {
    const c = streams.get(streamId);
    if (c) {
      try { c(); } catch { /* noop */ }
      streams.delete(streamId);
    }
    return { ok: true as const };
  });

  ipcMain.handle("pig:terminal:create", async (e, params: { cols?: number; rows?: number; workspace?: string }) => {
    const id = randomUUID();
    const raw = params.workspace && params.workspace.trim() ? params.workspace.trim() : getWorkspace();
    let cwd: string;
    try {
      cwd = validateWorkspacePath(raw);
    } catch {
      cwd = getWorkspace();
    }
    const pty = await createPty({ cols: params.cols, rows: params.rows, cwd });
    terminals.set(id, { pty, cwd: path.resolve(cwd) });
    const sender: WebContents = e.sender;
    pty.onData((data) => {
      if (!sender.isDestroyed()) sender.send(`pig:terminal:${id}`, { type: "data", data });
    });
    pty.onExit((info) => {
      if (!sender.isDestroyed()) sender.send(`pig:terminal:${id}`, { type: "exit", exitCode: info.exitCode });
      terminals.delete(id);
    });
    return { id };
  });

  ipcMain.on("pig:terminal:write", (_e, { id, data }: { id: string; data: string }) => {
    terminals.get(id)?.pty.write(data);
  });
  ipcMain.on("pig:terminal:resize", (_e, { id, cols, rows }: { id: string; cols: number; rows: number }) => {
    terminals.get(id)?.pty.resize(cols, rows);
  });
  ipcMain.on("pig:terminal:kill", (_e, { id }: { id: string }) => {
    try { terminals.get(id)?.pty.kill(); } catch { /* noop */ }
    terminals.delete(id);
  });

  // ---- Custom title bar (frameless window) ---------------------------------
  ipcMain.handle("pig:window:minimize", () => {
    getWindow()?.minimize();
  });
  ipcMain.handle("pig:window:maximize", () => {
    const win = getWindow();
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.handle("pig:window:close", () => {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.destroy(); // Forcefully destroy the window to bypass any beforeunload handlers
    }
    app.quit();
  });
  ipcMain.handle("pig:window:isMaximized", () => getWindow()?.isMaximized() ?? false);

  // ---- UI zoom (persisted in electron-store) -------------------------------
  ipcMain.handle("pig:zoom:get", () => ({ percent: getUiZoomPercent() }));
  ipcMain.handle("pig:zoom:set", (_e, percent: number) => {
    const p = setUiZoomPercent(percent);
    applyWindowZoom(getWindow(), p);
    return { percent: p };
  });
  ipcMain.handle("pig:zoom:step", (_e, delta: number) => {
    const p = stepUiZoomPercent(Number(delta) || 0);
    applyWindowZoom(getWindow(), p);
    return { percent: p };
  });

  // ---- Clipboard -----------------------------------------------------------
  ipcMain.handle("pig:clipboard:read", () => clipboard.readText());
  ipcMain.handle("pig:clipboard:write", (_e, text: string) => clipboard.writeText(text));

  // ---- Native folder picker ------------------------------------------------
  ipcMain.handle("pig:workspace:pickFolder", async () => {
    const win = getWindow();
    const opts: OpenDialogOptions = { properties: ["openDirectory"], title: "Open workspace folder" };
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (result.canceled || !result.filePaths[0]) return { workspace: getWorkspace() };
    const ws = setWorkspace(result.filePaths[0]);
    logger.info("workspace opened", ws);
    return { workspace: ws };
  });
}
