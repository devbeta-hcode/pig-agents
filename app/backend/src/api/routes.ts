import { Router, type Request, type Response } from "express";
import { listFiles, readFile, writeFile, createEntry, deleteEntry, copyEntry, searchCode } from "../tools/file.js";
import { runCommand } from "../tools/command.js";
import { runAgent } from "../agent/runner.js";
import {
  startSession,
  getSession,
  listSessions,
  getRunningSessions,
  subscribeToSession,
  abortSession,
  deleteSession,
  getStats as getSessionStats,
} from "../agent/sessionManager.js";
import {
  clearAgentCommands,
  deleteAgentCommand,
  getAgentCommand,
  listAgentCommands,
  subscribeAgentCommands,
} from "../agent/commandLog.js";
import { getWorkspace, setWorkspace } from "../utils/workspace.js";
import { logger } from "../utils/logger.js";
import {
  createCheckpoint,
  deleteCheckpoint,
  listCheckpoints,
  restoreCheckpoint,
} from "../utils/checkpoints.js";
import { loadPolicy, savePolicy, setAutoApprove, trust as policyTrust, type Policy } from "../utils/policy.js";
import { resolveApproval, type ApprovalDecision } from "../utils/approvals.js";

export const router = Router();

router.get("/health", (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

router.get("/workspace", (_req, res) => {
  res.json({ workspace: getWorkspace() });
});

router.post("/workspace", (req: Request, res: Response) => {
  try {
    const p = String(req.body?.path || "");
    if (!p) return res.status(400).json({ error: "path required" });
    const ws = setWorkspace(p);
    res.json({ workspace: ws });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.get("/files", async (req, res) => {
  try {
    const dir = String(req.query.dir ?? ".");
    const items = await listFiles(dir);
    res.json({ dir, items });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.get("/file", async (req, res) => {
  try {
    const p = String(req.query.path ?? "");
    if (!p) return res.status(400).json({ error: "path required" });
    const content = await readFile(p);
    res.json({ path: p, content });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.post("/file", async (req, res) => {
  try {
    const p = String(req.body?.path || "");
    const content = String(req.body?.content ?? "");
    if (!p) return res.status(400).json({ error: "path required" });
    await writeFile(p, content);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.post("/entries", async (req, res) => {
  try {
    const p = String(req.body?.path || "");
    const kind = req.body?.kind === "dir" ? "dir" : "file";
    if (!p) return res.status(400).json({ error: "path required" });
    await createEntry(p, kind);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.post("/entries/copy", async (req, res) => {
  try {
    const from = String(req.body?.from || "");
    const to = String(req.body?.to || "");
    if (!from || !to) return res.status(400).json({ error: "from and to required" });
    const finalPath = await copyEntry(from, to);
    res.json({ ok: true, path: finalPath });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.delete("/entries", async (req, res) => {
  try {
    const p = String(req.query.path ?? "");
    if (!p) return res.status(400).json({ error: "path required" });
    await deleteEntry(p);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.get("/search", async (req, res) => {
  try {
    const q = String(req.query.query ?? "");
    if (!q) return res.status(400).json({ error: "query required" });
    const hits = await searchCode(q, 100);
    res.json({ query: q, hits });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.post("/terminal", async (req, res) => {
  try {
    const cmd = String(req.body?.cmd ?? "");
    if (!cmd) return res.status(400).json({ error: "cmd required" });
    const r = await runCommand(cmd, { timeoutMs: 120_000 });
    res.json(r);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.post("/agent/run", async (req, res) => {
  const task = String(req.body?.task || "");
  if (!task) return res.status(400).json({ error: "task required" });
  const mode = req.body?.mode === "ask" ? "ask" : "agent";
  // A stable id for this run, surfaced in the very first SSE event so the
  // frontend can scope policy_ask answers and checkpoint pills to the right
  // turn even when several runs interleave.
  const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  // SSE if requested
  const wantsStream = req.query.stream === "1" || req.headers.accept === "text/event-stream";
  if (wantsStream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    // Tell the client which runId this stream belongs to BEFORE any agent
    // events. The frontend uses this to correlate /agent/approvals/:askId
    // POSTs back to the right modal.
    send("run_started", { runId });
    const ac = new AbortController();
    // Use res.on("close") — fires only when client disconnects before res.end().
    // (req.on("close") can fire when the request body finishes being read.)
    res.on("close", () => {
      if (!res.writableEnded) ac.abort();
    });
    try {
      const result = await runAgent({
        task,
        mode,
        runId,
        signal: ac.signal,
        onEvent: (e: { type: string }) => send(e.type, e),
      });
      send("done", { iterations: result.iterations, result: result.result, diffs: result.diffs, runId });
    } catch (err) {
      const e = err as Error & { __emitted?: boolean };
      const msg = e.message;
      // Only send if the runner hasn't already emitted an error event.
      if (msg !== "aborted" && !e.__emitted) send("error", { message: msg });
    } finally {
      res.end();
    }
    return;
  }

  try {
    const result = await runAgent({ task, mode, runId });
    res.json({
      result: result.result,
      iterations: result.iterations,
      diffs: result.diffs,
      logs: result.events,
      runId,
    });
  } catch (err) {
    logger.error("agent run failed", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// ---- Approval bridge -----------------------------------------------------
// The runner blocks on `waitForApproval(askId, …)` while the SSE stream is
// open. This endpoint is how the user's click in the browser unblocks it.
router.post("/agent/approvals/:askId", (req, res) => {
  const askId = String(req.params.askId || "");
  const decision = String(req.body?.decision || "") as ApprovalDecision;
  const editedCmd = typeof req.body?.editedCmd === "string" ? req.body.editedCmd : undefined;
  if (!["allow_once", "allow_always", "deny"].includes(decision)) {
    return res.status(400).json({ error: "decision must be allow_once | allow_always | deny" });
  }
  const ok = resolveApproval(askId, { decision, editedCmd });
  if (!ok) return res.status(404).json({ error: "no pending approval with that askId (timed out or already answered)" });
  res.json({ ok: true });
});

// ---- Checkpoints ---------------------------------------------------------

router.get("/checkpoints", async (_req, res) => {
  try {
    const items = await listCheckpoints();
    res.json({ workspace: getWorkspace(), checkpoints: items });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post("/checkpoints", async (req, res) => {
  try {
    const label = String(req.body?.label || `Manual ${new Date().toLocaleTimeString()}`);
    const cp = await createCheckpoint(label, { kind: "manual" });
    if (!cp) return res.status(500).json({ error: "could not create checkpoint (git unavailable?)" });
    res.json({ ok: true, checkpoint: cp });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post("/checkpoints/:id/restore", async (req, res) => {
  try {
    const r = await restoreCheckpoint(String(req.params.id));
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.delete("/checkpoints/:id", async (req, res) => {
  try {
    const ok = await deleteCheckpoint(String(req.params.id));
    if (!ok) return res.status(404).json({ error: "not found" });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ---- Command policy ------------------------------------------------------

router.get("/policy", async (_req, res) => {
  try {
    const p = await loadPolicy();
    res.json({ workspace: getWorkspace(), policy: p });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.put("/policy", async (req, res) => {
  try {
    const body = req.body as Partial<Policy>;
    if (!body || typeof body !== "object") return res.status(400).json({ error: "body must be a policy object" });
    const next: Policy = {
      version: 1,
      deny: Array.isArray(body.deny) ? body.deny.map(String) : [],
      allow: Array.isArray(body.allow) ? body.allow.map(String) : [],
      trusted: Array.isArray(body.trusted) ? body.trusted.map(String) : [],
      autoApprove: !!body.autoApprove,
    };
    await savePolicy(next);
    res.json({ ok: true, policy: next });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post("/policy/auto-approve", async (req, res) => {
  try {
    const value = !!req.body?.value;
    const p = await setAutoApprove(value);
    res.json({ ok: true, autoApprove: !!p.autoApprove, policy: p });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post("/policy/trust", async (req, res) => {
  try {
    const pattern = String(req.body?.pattern || "").trim();
    if (!pattern) return res.status(400).json({ error: "pattern required" });
    const p = await policyTrust(pattern);
    res.json({ ok: true, policy: p });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ---- Agent command log ---------------------------------------------------
// The list view shows lightweight metadata; the detail view returns the full
// captured stdout/stderr so the IDE can render it as a virtual terminal.

router.get("/agent/commands", (_req, res) => {
  res.json({ runs: listAgentCommands() });
});

router.get("/agent/commands/stream", (_req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  send("hello", { runs: listAgentCommands() });
  // Keep-alive comments every 25s so proxies / browsers don't close idle conns.
  const ka = setInterval(() => { try { res.write(": keepalive\n\n"); } catch { /* noop */ } }, 25_000);
  const unsub = subscribeAgentCommands(
    (run) => send("run", run),
    () => send("clear", {}),
    (id) => send("delete", { id }),
  );
  res.on("close", () => {
    clearInterval(ka);
    unsub();
    if (!res.writableEnded) res.end();
  });
});

router.get("/agent/commands/:id", (req, res) => {
  const r = getAgentCommand(req.params.id);
  if (!r) return res.status(404).json({ error: "not found" });
  res.json(r);
});

router.delete("/agent/commands", (_req, res) => {
  const removed = clearAgentCommands();
  res.json({ ok: true, removed });
});

router.delete("/agent/commands/:id", (req, res) => {
  const ok = deleteAgentCommand(req.params.id);
  if (!ok) return res.status(404).json({ error: "not found" });
  res.json({ ok: true, id: req.params.id });
});

// ---- Agent sessions (background mode) ------------------------------------
// Sessions run independently of client connections. Clients can
// connect/disconnect/reconnect without affecting running agents.

/** Start a new background agent session */
router.post("/agent/sessions", (req: Request, res: Response) => {
  const task = String(req.body?.task || "");
  if (!task) return res.status(400).json({ error: "task required" });
  
  const mode = req.body?.mode === "ask" ? "ask" : "agent";
  const workspace = getWorkspace();
  
  // Extract images (array of { dataUrl, name })
  const images = Array.isArray(req.body?.images) 
    ? req.body.images.filter((img: unknown) => 
        img && typeof img === "object" && 
        typeof (img as Record<string, unknown>).dataUrl === "string"
      )
    : undefined;
  
  const session = startSession(task, mode, workspace, images);
  res.json({ ok: true, session });
});

/** List all sessions (optionally filter by workspace) */
router.get("/agent/sessions", (_req, res) => {
  const workspace = getWorkspace();
  const sessions = listSessions(workspace);
  const stats = getSessionStats();
  res.json({ sessions, stats, workspace });
});

/** Get currently running sessions for current workspace */
router.get("/agent/sessions/running", (_req, res) => {
  const workspace = getWorkspace();
  const running = getRunningSessions(workspace);
  res.json({ running, workspace });
});

/** Get ALL running sessions across ALL workspaces (for workspace manager) */
router.get("/agent/sessions/all-running", (_req, res) => {
  // Pass undefined to get sessions from all workspaces
  const running = getRunningSessions(undefined);
  res.json({ running });
});

/** Get a specific session */
router.get("/agent/sessions/:id", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "session not found" });
  res.json({ session });
});

/** SSE stream for session events - replays all events then streams new ones */
router.get("/agent/sessions/:id/stream", (req, res) => {
  const sessionId = req.params.id;
  const session = getSession(sessionId);
  
  if (!session) {
    return res.status(404).json({ error: "session not found" });
  }
  
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  
  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  
  // Send session metadata first
  send("session_info", {
    id: session.id,
    task: session.task,
    mode: session.mode,
    status: session.status,
    createdAt: session.createdAt,
    completedAt: session.completedAt,
    eventCount: session.events.length,
  });
  
  // Subscribe to session (will replay all events)
  const unsubscribe = subscribeToSession(sessionId, (event) => {
    send(event.type, event);
  }, true);
  
  if (!unsubscribe) {
    send("error", { message: "failed to subscribe to session" });
    res.end();
    return;
  }
  
  // If session is already done, send completion and close
  if (session.status !== "running") {
    send("session_ended", {
      status: session.status,
      result: session.result?.result,
      error: session.error,
    });
    // Keep connection open briefly so client receives all events
    setTimeout(() => {
      unsubscribe();
      res.end();
    }, 100);
    return;
  }
  
  // Keep-alive for running sessions
  const keepalive = setInterval(() => {
    try { res.write(": keepalive\n\n"); } catch { /* noop */ }
  }, 25_000);
  
  res.on("close", () => {
    clearInterval(keepalive);
    unsubscribe();
    // Agent continues running - client just disconnected
  });
});

/** Abort a running session */
router.post("/agent/sessions/:id/abort", (req, res) => {
  const ok = abortSession(req.params.id);
  if (!ok) {
    return res.status(400).json({ error: "session not found or not running" });
  }
  res.json({ ok: true, id: req.params.id });
});

/** Delete a completed session */
router.delete("/agent/sessions/:id", (req, res) => {
  const ok = deleteSession(req.params.id);
  if (!ok) {
    return res.status(400).json({ error: "session not found or still running" });
  }
  res.json({ ok: true, id: req.params.id });
});
