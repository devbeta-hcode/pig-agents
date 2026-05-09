import "dotenv/config";
import express from "express";
import cors from "cors";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { WebSocketServer } from "ws";
import { router } from "./api/routes.js";
import { fsRouter } from "./api/fs.js";
import { settingsRouter } from "./api/settings.js";
import { diffRouter } from "./api/diff.js";
import { chatsRouter } from "./api/chats.js";
import { gitRouter } from "./api/git.js";
import { browserRouter } from "./api/browser.js";
import { browserSession } from "./browser/session.js";
import { createPty } from "./tools/terminal.js";
import { logger } from "./utils/logger.js";
import { workspaceWatcher, type WorkspaceChangesPayload } from "./utils/watcher.js";
import { getWorkspace, onWorkspaceChange, validateWorkspacePath } from "./utils/workspace.js";
import { workspaceMiddleware } from "./api/workspaceMiddleware.js";
import { hydrateEnvFromProfiles } from "./llm/profiles.js";

// Load .env from app/.env when running from backend/
try {
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const dotenv = await import("dotenv");
  dotenv.config({ path: path.resolve(here, "../../.env") });
  dotenv.config({ path: path.resolve(here, "../../../.env") });
} catch { /* dotenv already loaded above */ }

hydrateEnvFromProfiles();

/** REST handlers use `/api/*` — same prefix as Vite dev proxy (`app/frontend`). */
const API_PREFIX = "/api";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "../public");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(workspaceMiddleware);
app.use(API_PREFIX, fsRouter);
app.use(API_PREFIX, settingsRouter);
app.use(API_PREFIX, diffRouter);
app.use(API_PREFIX, chatsRouter);
app.use(API_PREFIX, gitRouter);
app.use(API_PREFIX, browserRouter);
app.use(API_PREFIX, router);

/** Load-balancer friendly without the `/api` prefix (mirrors `GET /api/health`). */
app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
  const indexHtml = path.join(publicDir, "index.html");
  app.get("*", (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (req.path.startsWith(API_PREFIX)) return next();
    res.sendFile(indexHtml, (err) => (err ? next(err) : undefined));
  });
}

const PORT = Number(process.env.PORT || 8787);
const server = http.createServer(app);
// Don't let stale keep-alives outlive the process during dev reloads.
server.keepAliveTimeout = 1000;
server.headersTimeout = 2000;

// ---------------------------------------------------------------------------
// Filesystem watcher: a single recursive fs.watch on the active workspace,
// fanned out over a /fs/watch WebSocket so the file tree (and anything else
// that cares) updates in real time without manual refresh.
// ---------------------------------------------------------------------------
workspaceWatcher.start();
onWorkspaceChange(() => workspaceWatcher.start());

// IMPORTANT: We attach two WebSocket endpoints to the same HTTP server. The
// `ws` library's automatic upgrade routing breaks down when multiple servers
// share an HTTP server (each adds its own `upgrade` listener and they
// stomp on each other, causing immediate 1006 disconnects). The fix is
// `noServer: true` + a single, explicit upgrade router below.
const fsWss = new WebSocketServer({ noServer: true });
const wss = new WebSocketServer({ noServer: true });
const browserWss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const pathname = new URL(req.url || "/", "http://x").pathname;
  if (pathname === "/fs/watch") {
    fsWss.handleUpgrade(req, socket, head, (ws) => fsWss.emit("connection", ws, req));
  } else if (pathname === "/terminal/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else if (pathname === "/browser/ws") {
    browserWss.handleUpgrade(req, socket, head, (ws) => browserWss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

// Browser screencast: fan out BrowserSession events to all connected WS clients.
browserWss.on("connection", (ws) => {
  const onEvent = (ev: unknown) => {
    if (ws.readyState === ws.OPEN) {
      try { ws.send(JSON.stringify(ev)); } catch { /* noop */ }
    }
  };
  browserSession.on("event", onEvent);
  // Immediately send current status so the client can initialise its UI
  browserSession.isPlaywrightReady().then((installed) => {
    onEvent({ type: "status", status: "idle", installed, running: browserSession.isStarted() });
  }).catch(() => { /* noop */ });
  ws.on("close", () => browserSession.off("event", onEvent));
  ws.on("error", () => browserSession.off("event", onEvent));
});

fsWss.on("connection", (ws, req) => {
  const u = new URL(req.url || "/", "http://x");
  let root: string;
  try {
    const qp = u.searchParams.get("workspace");
    root = qp?.trim() ? validateWorkspacePath(qp) : getWorkspace();
  } catch (err) {
    try { ws.close(4400, (err as Error).message); } catch { /* noop */ }
    return;
  }
  workspaceWatcher.ensureWatching(root);
  const onChanges = (payload: WorkspaceChangesPayload) => {
    if (payload.workspace !== root) return;
    if (ws.readyState !== ws.OPEN) return;
    try { ws.send(JSON.stringify({ type: "fs:changes", changes: payload.changes })); }
    catch { /* connection closing — drop frame */ }
  };
  workspaceWatcher.on("changes", onChanges);
  // Initial hello so the client knows the channel is live.
  try { ws.send(JSON.stringify({ type: "fs:ready" })); } catch { /* noop */ }
  ws.on("close", () => workspaceWatcher.off("changes", onChanges));
  ws.on("error", () => workspaceWatcher.off("changes", onChanges));
});

wss.on("connection", async (ws, req) => {
  const u = new URL(req.url || "/", "http://x");
  const cols = Number(u.searchParams.get("cols") || 100);
  const rows = Number(u.searchParams.get("rows") || 30);
  let cwd: string | undefined;
  try {
    const qp = u.searchParams.get("workspace");
    if (qp?.trim()) cwd = validateWorkspacePath(qp);
  } catch (err) {
    try { ws.close(4400, (err as Error).message); } catch { /* noop */ }
    return;
  }
  logger.info(`terminal ws connected (${cols}x${rows}) cwd=${cwd ?? getWorkspace()}`);

  const pty = await createPty({ cols, rows, cwd });

  pty.onData((chunk) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "data", data: chunk }));
  });
  pty.onExit(({ exitCode }) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "exit", exitCode }));
    try { ws.close(); } catch { /* noop */ }
  });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "input" && typeof msg.data === "string") pty.write(msg.data);
      else if (msg.type === "resize") pty.resize(Number(msg.cols) || 100, Number(msg.rows) || 30);
    } catch {
      // ignore malformed frames
    }
  });

  ws.on("close", () => {
    pty.kill();
    logger.info("terminal ws closed");
  });
});

function startListening(): void {
  server.listen(PORT, () => {
    logger.info(`backend listening on http://localhost:${PORT}`);
  });
}

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    // Most common cause: tsx watch reloaded before the previous process let
    // go of the port (long-lived SSE / WS keep the socket alive). Retry a
    // few times with exponential-ish backoff before giving up so the dev
    // loop heals itself instead of forcing a manual `kill`.
    const tries = (server as unknown as { _baTries?: number })._baTries ?? 0;
    if (tries < 8) {
      (server as unknown as { _baTries?: number })._baTries = tries + 1;
      const delay = 150 + tries * 150;
      logger.warn(`Port ${PORT} busy, retry ${tries + 1}/8 in ${delay}ms…`);
      setTimeout(() => {
        try { server.close(); } catch { /* noop */ }
        server.listen(PORT);
      }, delay);
      return;
    }
    logger.error(
      `Port ${PORT} still in use after retries. ` +
      `Run: lsof -ti:${PORT} | xargs -r kill -9`,
    );
    process.exit(1);
  }
  throw err;
});

// ---------------------------------------------------------------------------
// Graceful shutdown — SIGTERM is what `tsx watch` sends when it restarts on
// file change. Without this, persistent SSE responses and WS connections
// keep the HTTP server alive past tsx's grace window, the new process tries
// to listen() before the kernel releases the port, and we hit EADDRINUSE.
// We close the listener, terminate every WS, destroy keep-alive sockets,
// and force-exit after a short timeout if anything is still hanging.
// ---------------------------------------------------------------------------
let shuttingDown = false;
function shutdown(signal: NodeJS.Signals | "uncaught") {
  if (shuttingDown) {
    // Second signal: hard exit immediately.
    process.exit(0);
  }
  shuttingDown = true;
  logger.info(`Received ${signal}, shutting down...`);

  for (const w of [fsWss, wss, browserWss]) {
    for (const client of w.clients) {
      try { client.terminate(); } catch { /* noop */ }
    }
    try { w.close(); } catch { /* noop */ }
  }

  // Node 18.2+: actively kill every open HTTP socket (SSE, keep-alive, …)
  // so server.close() resolves instead of waiting for clients to disconnect.
  try { server.closeAllConnections?.(); } catch { /* noop */ }

  server.close(() => {
    logger.info("backend closed cleanly");
    process.exit(0);
  });

  // Belt-and-suspenders: tsx watch's grace window before SIGKILL is short,
  // and we'd rather force-exit than miss it and hit EADDRINUSE on the next
  // reload.
  setTimeout(() => {
    logger.warn("forced shutdown after 500ms");
    process.exit(0);
  }, 500).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
// tsx watch sends SIGUSR2 in some setups (nodemon-style restart).
process.on("SIGUSR2", () => shutdown("SIGUSR2" as NodeJS.Signals));
process.on("SIGHUP", () => shutdown("SIGHUP"));

startListening();
