import { Router } from "express";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

export const chatsRouter = Router();

// Storage layout
//   ~/.build-agents/chats/<wsHash>/
//     index.json         lightweight metadata (id/title/turnCount/...)
//     <sessionId>.json   full session payload (turns + events)
//
// We split list-vs-detail so the sidebar is cheap to render and we only pay
// the cost of reading a full conversation when the user actually opens it.

interface ChatTurn {
  id: string;
  task: string;
  mode?: "ask" | "agent";
  events: unknown[];
  status: "idle" | "running" | "done" | "error" | "stopped";
  startedAt: number;
  endedAt?: number;
}

interface ChatSession {
  id: string;
  title: string;
  workspace: string;
  mode?: "ask" | "agent";
  createdAt: number;
  updatedAt: number;
  turns: ChatTurn[];
  /** Agent diff review tray — optional; omitted in older session files. */
  pendingDiffs?: unknown[];
}

interface SessionMeta {
  id: string;
  title: string;
  workspace: string;
  mode?: "ask" | "agent";
  createdAt: number;
  updatedAt: number;
  turnCount: number;
}

function rootDir(): string {
  return path.join(os.homedir(), ".build-agents", "chats");
}

function workspaceHash(ws: string): string {
  return crypto.createHash("sha1").update(path.resolve(ws)).digest("hex").slice(0, 16);
}

function workspaceDir(ws: string): string {
  return path.join(rootDir(), workspaceHash(ws));
}

async function ensureDir(p: string) {
  await fsp.mkdir(p, { recursive: true });
}

async function safeReadJSON<T>(p: string, fallback: T): Promise<T> {
  try {
    const raw = await fsp.readFile(p, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function atomicWrite(p: string, data: string) {
  const dir = path.dirname(p);
  await ensureDir(dir);
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, data, "utf8");
  await fsp.rename(tmp, p);
}

function isValidId(id: string): boolean {
  return typeof id === "string" && /^[A-Za-z0-9_\-]+$/.test(id) && id.length > 0 && id.length < 80;
}

function indexPath(ws: string): string {
  return path.join(workspaceDir(ws), "index.json");
}

function sessionPath(ws: string, id: string): string {
  if (!isValidId(id)) throw new Error("invalid session id");
  return path.join(workspaceDir(ws), `${id}.json`);
}

function readIndex(ws: string): Promise<SessionMeta[]> {
  return safeReadJSON<SessionMeta[]>(indexPath(ws), []);
}

async function writeIndex(ws: string, list: SessionMeta[]) {
  await atomicWrite(indexPath(ws), JSON.stringify(list, null, 2));
}

function metaFromSession(s: ChatSession): SessionMeta {
  return {
    id: s.id,
    title: s.title,
    workspace: s.workspace,
    mode: s.mode,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    turnCount: Array.isArray(s.turns) ? s.turns.length : 0,
  };
}

function getWorkspaceParam(req: any, res: any): string | null {
  const ws = (req.query.workspace || req.body?.workspace) as string | undefined;
  if (!ws || typeof ws !== "string" || ws.trim().length === 0) {
    res.status(400).json({ error: "workspace param required" });
    return null;
  }
  return ws;
}

// ---- routes ---------------------------------------------------------------

chatsRouter.get("/chats", async (req, res) => {
  const ws = getWorkspaceParam(req, res);
  if (!ws) return;
  const list = (await readIndex(ws)).sort((a, b) => b.updatedAt - a.updatedAt);
  res.json({ workspace: ws, sessions: list });
});

// Full-text search across all session files for the workspace. Returns the
// session metadata + a small snippet for each match so the UI can show why a
// session matched. We grep the raw file as text to keep this cheap and avoid
// JSON.parse for files that obviously don't match.
chatsRouter.get("/chats/search", async (req, res) => {
  const ws = getWorkspaceParam(req, res);
  if (!ws) return;
  const q = String(req.query.q || "").trim();
  if (q.length === 0) return res.json({ workspace: ws, query: q, hits: [] });
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const dir = workspaceDir(ws);
  try { await fsp.access(dir); } catch { return res.json({ workspace: ws, query: q, hits: [] }); }
  const idx = await readIndex(ws);
  const ql = q.toLowerCase();
  type Hit = { id: string; title: string; updatedAt: number; snippet: string; matches: number };
  const hits: Hit[] = [];
  // Pull a snippet around the first occurrence of `ql` in `text`.
  function snippetFrom(text: string): string {
    const at = text.toLowerCase().indexOf(ql);
    if (at < 0) return "";
    const start = Math.max(0, at - 60);
    const end = Math.min(text.length, at + ql.length + 60);
    return (start > 0 ? "…" : "") + text.slice(start, end).replace(/\s+/g, " ").trim() + (end < text.length ? "…" : "");
  }
  for (const meta of idx) {
    if (hits.length >= limit) break;
    const titleMatch = meta.title.toLowerCase().includes(ql);
    const sp = path.join(dir, `${meta.id}.json`);
    let raw = "";
    try { raw = await fsp.readFile(sp, "utf8"); } catch { continue; }
    if (!titleMatch && !raw.toLowerCase().includes(ql)) continue;

    // Try to extract a content-aware snippet by walking turns. Falls back to a
    // raw-text snippet (which may contain JSON noise) if parsing fails or the
    // match lives outside any user/agent text field.
    let snippet = "";
    let matches = 0;
    try {
      const sess = JSON.parse(raw) as ChatSession;
      const turns = Array.isArray(sess.turns) ? sess.turns : [];
      const buckets: string[] = [];
      for (const t of turns) {
        const turn = t as unknown as Record<string, unknown>;
        if (typeof turn.task === "string") buckets.push(turn.task);
        if (typeof turn.final === "string") buckets.push(turn.final);
        const events = (t as { events?: unknown }).events;
        if (Array.isArray(events)) {
          for (const ev of events) {
            const o = ev as Record<string, unknown>;
            for (const k of ["text", "message", "content", "output"]) {
              const v = o[k];
              if (typeof v === "string") buckets.push(v);
            }
          }
        }
      }
      for (const b of buckets) {
        const lo = b.toLowerCase();
        let scan = lo.indexOf(ql);
        while (scan >= 0) { matches++; if (matches >= 50) break; scan = lo.indexOf(ql, scan + ql.length); }
        if (!snippet) {
          const s = snippetFrom(b);
          if (s) snippet = s;
        }
      }
      if (!snippet && titleMatch) snippet = sess.title;
    } catch { /* fall through */ }

    if (!snippet) {
      // Last-resort: raw-text snippet from the whole file body.
      snippet = snippetFrom(raw) || meta.title;
      if (matches === 0) matches = 1;
    }
    hits.push({ id: meta.id, title: meta.title, updatedAt: meta.updatedAt, snippet, matches: matches || 1 });
  }
  hits.sort((a, b) => b.matches - a.matches || b.updatedAt - a.updatedAt);
  res.json({ workspace: ws, query: q, hits });
});

// Bundle all sessions for a workspace into one JSON document the user can save.
chatsRouter.get("/chats/export", async (req, res) => {
  const ws = getWorkspaceParam(req, res);
  if (!ws) return;
  const idx = await readIndex(ws);
  const sessions: ChatSession[] = [];
  for (const meta of idx) {
    try {
      const raw = await fsp.readFile(sessionPath(ws, meta.id), "utf8");
      sessions.push(JSON.parse(raw));
    } catch { /* skip broken */ }
  }
  const bundle = {
    kind: "build-agents.chats.v1",
    workspace: ws,
    exportedAt: Date.now(),
    sessions,
  };
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="build-agents-chats-${workspaceHash(ws)}.json"`,
  );
  res.json(bundle);
});

// Import a bundle (or a raw array of sessions). Collisions get a fresh id so
// nothing is silently overwritten.
chatsRouter.post("/chats/import", async (req, res) => {
  const ws = getWorkspaceParam(req, res);
  if (!ws) return;
  const body = req.body || {};
  const raw: unknown = Array.isArray(body) ? body : Array.isArray(body.sessions) ? body.sessions : null;
  if (!raw) return res.status(400).json({ error: "expected { sessions: [...] } or [...]" });
  const incoming = raw as ChatSession[];
  const idx = await readIndex(ws);
  const existing = new Set(idx.map((m) => m.id));
  let imported = 0;
  for (const s of incoming) {
    if (!s || typeof s !== "object" || typeof s.title !== "string") continue;
    let id = typeof s.id === "string" && isValidId(s.id) ? s.id : "";
    if (!id || existing.has(id)) {
      id = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    }
    const session: ChatSession = {
      id,
      title: s.title,
      workspace: ws,
      mode: s.mode,
      createdAt: Number(s.createdAt) || Date.now(),
      updatedAt: Number(s.updatedAt) || Date.now(),
      turns: Array.isArray(s.turns) ? s.turns : [],
      pendingDiffs: Array.isArray((s as { pendingDiffs?: unknown }).pendingDiffs)
        ? ((s as { pendingDiffs: unknown[] }).pendingDiffs)
        : [],
    };
    try {
      await atomicWrite(sessionPath(ws, id), JSON.stringify(session));
      existing.add(id);
      const meta = metaFromSession(session);
      const i = idx.findIndex((m) => m.id === id);
      if (i >= 0) idx[i] = meta; else idx.push(meta);
      imported++;
    } catch { /* skip */ }
  }
  await writeIndex(ws, idx);
  res.json({ ok: true, imported, total: incoming.length });
});

chatsRouter.get("/chats/:id", async (req, res) => {
  const ws = getWorkspaceParam(req, res);
  if (!ws) return;
  const id = req.params.id;
  if (!isValidId(id)) return res.status(400).json({ error: "invalid id" });
  try {
    const p = sessionPath(ws, id);
    const data = await fsp.readFile(p, "utf8");
    res.type("application/json").send(data);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return res.status(404).json({ error: "not found" });
    }
    res.status(500).json({ error: (err as Error).message });
  }
});

chatsRouter.put("/chats/:id", async (req, res) => {
  const ws = getWorkspaceParam(req, res);
  if (!ws) return;
  const id = req.params.id;
  if (!isValidId(id)) return res.status(400).json({ error: "invalid id" });
  const body = req.body as Partial<ChatSession>;
  if (!body || body.id !== id) return res.status(400).json({ error: "id mismatch" });
    const session: ChatSession = {
      id,
      title: String(body.title ?? "New chat"),
      workspace: ws,
      mode: body.mode,
      createdAt: Number(body.createdAt ?? Date.now()),
      updatedAt: Number(body.updatedAt ?? Date.now()),
      turns: Array.isArray(body.turns) ? (body.turns as ChatTurn[]) : [],
      pendingDiffs: Array.isArray(body.pendingDiffs) ? body.pendingDiffs : [],
    };
  try {
    await atomicWrite(sessionPath(ws, id), JSON.stringify(session));
    const idx = await readIndex(ws);
    const meta = metaFromSession(session);
    const i = idx.findIndex((m) => m.id === id);
    if (i >= 0) idx[i] = meta; else idx.push(meta);
    await writeIndex(ws, idx);
    res.json({ ok: true, meta });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

chatsRouter.patch("/chats/:id", async (req, res) => {
  // Lightweight metadata patch (rename / mode change). Avoids re-writing the
  // entire session file when only the title changes.
  const ws = getWorkspaceParam(req, res);
  if (!ws) return;
  const id = req.params.id;
  if (!isValidId(id)) return res.status(400).json({ error: "invalid id" });
  const patch = req.body as Partial<ChatSession>;
  try {
    const sp = sessionPath(ws, id);
    const curRaw = await fsp.readFile(sp, "utf8");
    const cur = JSON.parse(curRaw) as ChatSession;
    const next: ChatSession = {
      ...cur,
      title: typeof patch.title === "string" ? patch.title : cur.title,
      mode: patch.mode ?? cur.mode,
      updatedAt: Date.now(),
    };
    await atomicWrite(sp, JSON.stringify(next));
    const idx = await readIndex(ws);
    const i = idx.findIndex((m) => m.id === id);
    if (i >= 0) {
      idx[i] = metaFromSession(next);
      await writeIndex(ws, idx);
    }
    res.json({ ok: true, meta: metaFromSession(next) });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return res.status(404).json({ error: "not found" });
    }
    res.status(500).json({ error: (err as Error).message });
  }
});

chatsRouter.delete("/chats/:id", async (req, res) => {
  const ws = getWorkspaceParam(req, res);
  if (!ws) return;
  const id = req.params.id;
  if (!isValidId(id)) return res.status(400).json({ error: "invalid id" });
  try {
    const sp = sessionPath(ws, id);
    try { await fsp.unlink(sp); } catch { /* file may not exist */ }
    const idx = (await readIndex(ws)).filter((m) => m.id !== id);
    await writeIndex(ws, idx);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
