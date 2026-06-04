/**
 * Per-chat run snapshots (Cursor / Copilot style): store **before** content only for
 * files the agent touches in a run. Lives under ~/.pig-agents/chats/<wsHash>/snapshots/<chatId>/.
 * Deleted when the chat session is deleted — not shared across the whole workspace.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { getWorkspace } from "./workspace.js";
import { writeFile, deleteEntry } from "../tools/file.js";
import { logger } from "./logger.js";

const CHATS_ROOT = path.join(os.homedir(), ".pig-agents", "chats");

/** Reuse same hash as services.ts chat storage. */
function workspaceHash(ws: string): string {
  return crypto.createHash("sha1").update(path.resolve(ws)).digest("hex").slice(0, 16);
}

function chatSnapshotsRoot(ws: string, chatId: string): string {
  return path.join(CHATS_ROOT, workspaceHash(ws), "snapshots", chatId);
}

function runDir(ws: string, chatId: string, runId: string): string {
  return path.join(chatSnapshotsRoot(ws, chatId), runId);
}

function manifestPath(ws: string, chatId: string, runId: string): string {
  return path.join(runDir(ws, chatId, runId), "manifest.json");
}

/** Safe filename for a workspace-relative path inside the snapshot dir. */
function snapFileName(relPath: string): string {
  return relPath.replace(/\\/g, "/").split("/").map((p) => encodeURIComponent(p)).join("__");
}

export interface RunSnapshotFile {
  path: string;
  createdFromAbsent?: boolean;
}

export interface RunSnapshotManifest {
  version: 1;
  workspace: string;
  chatId: string;
  runId: string;
  createdAt: number;
  files: RunSnapshotFile[];
}

export async function initRunSnapshot(
  chatId: string,
  runId: string,
  workspace?: string,
): Promise<void> {
  const ws = workspace ?? getWorkspace();
  const dir = runDir(ws, chatId, runId);
  await fsp.mkdir(dir, { recursive: true });
  const manifest: RunSnapshotManifest = {
    version: 1,
    workspace: ws,
    chatId,
    runId,
    createdAt: Date.now(),
    files: [],
  };
  await fsp.writeFile(manifestPath(ws, chatId, runId), JSON.stringify(manifest, null, 2), "utf8");
}

async function loadManifest(ws: string, chatId: string, runId: string): Promise<RunSnapshotManifest | null> {
  try {
    const raw = await fsp.readFile(manifestPath(ws, chatId, runId), "utf8");
    const m = JSON.parse(raw) as RunSnapshotManifest;
    if (m?.version === 1 && Array.isArray(m.files)) return m;
  } catch {
    /* missing */
  }
  return null;
}

async function saveManifest(m: RunSnapshotManifest): Promise<void> {
  await fsp.writeFile(
    manifestPath(m.workspace, m.chatId, m.runId),
    JSON.stringify(m, null, 2),
    "utf8",
  );
}

/**
 * Record pre-write bytes once per path per run (first write wins for rollback).
 */
export async function recordRunSnapshotFile(
  chatId: string,
  runId: string,
  relPath: string,
  beforeContent: string,
  opts?: { createdFromAbsent?: boolean; workspace?: string },
): Promise<void> {
  if (!chatId || !runId) return;
  const ws = opts?.workspace ?? getWorkspace();
  const dir = runDir(ws, chatId, runId);
  if (!fs.existsSync(dir)) await initRunSnapshot(chatId, runId, ws);

  let manifest = await loadManifest(ws, chatId, runId);
  if (!manifest) await initRunSnapshot(chatId, runId, ws);
  manifest = (await loadManifest(ws, chatId, runId))!;

  const norm = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (manifest.files.some((f) => f.path === norm)) return;

  const bodyPath = path.join(dir, snapFileName(norm));
  await fsp.writeFile(bodyPath, beforeContent, "utf8");
  manifest.files.push({ path: norm, createdFromAbsent: !!opts?.createdFromAbsent });
  await saveManifest(manifest);
}

/** Restore workspace files from a run snapshot (Cursor-style undo run). */
export async function restoreRunSnapshot(
  chatId: string,
  runId: string,
  workspace?: string,
): Promise<{ ok: true; restored: number } | { ok: false; error: string }> {
  const ws = workspace ?? getWorkspace();
  const manifest = await loadManifest(ws, chatId, runId);
  if (!manifest) return { ok: false, error: "run snapshot not found" };

  const dir = runDir(ws, chatId, runId);
  let restored = 0;
  for (const f of manifest.files) {
    const bodyPath = path.join(dir, snapFileName(f.path));
    try {
      if (f.createdFromAbsent) {
        try {
          await deleteEntry(f.path);
        } catch {
          /* already gone */
        }
      } else {
        const body = await fsp.readFile(bodyPath, "utf8");
        await writeFile(f.path, body);
      }
      restored++;
    } catch (err) {
      logger.warn(`runSnapshots: restore ${f.path}: ${(err as Error).message}`);
    }
  }
  return { ok: true, restored };
}

export function hasRunSnapshot(chatId: string, runId: string, workspace?: string): boolean {
  const ws = workspace ?? getWorkspace();
  return fs.existsSync(manifestPath(ws, chatId, runId));
}

const MAX_RUNS_PER_CHAT = 30;

async function trimOldRuns(ws: string, chatId: string): Promise<void> {
  const root = chatSnapshotsRoot(ws, chatId);
  try {
    const entries = await fsp.readdir(root, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => ({ name: e.name, path: path.join(root, e.name) }));
    if (dirs.length <= MAX_RUNS_PER_CHAT) return;
    const withTime = await Promise.all(
      dirs.map(async (d) => {
        try {
          const st = await fsp.stat(path.join(d.path, "manifest.json"));
          return { ...d, mtime: st.mtimeMs };
        } catch {
          return { ...d, mtime: 0 };
        }
      }),
    );
    withTime.sort((a, b) => a.mtime - b.mtime);
    const drop = withTime.slice(0, withTime.length - MAX_RUNS_PER_CHAT);
    for (const d of drop) {
      await fsp.rm(d.path, { recursive: true, force: true });
    }
  } catch {
    /* no dir */
  }
}

/** Remove all snapshot data for a chat (call from chatDelete). */
export async function purgeChatRunSnapshots(chatId: string, workspace?: string): Promise<void> {
  const ws = workspace ?? getWorkspace();
  const root = chatSnapshotsRoot(ws, chatId);
  try {
    await fsp.rm(root, { recursive: true, force: true });
  } catch {
    /* missing */
  }
}

export async function finalizeRunSnapshot(chatId: string, runId: string, workspace?: string): Promise<void> {
  await trimOldRuns(workspace ?? getWorkspace(), chatId);
}
