// Workspace checkpoint engine — the "agent safety net".
//
// Every agent run starts with a snapshot of the entire working tree so the
// user can roll back the *whole run* with one click.
//
// Two modes:
// 1. GIT-BASED (when workspace is a git repo): Uses git internals for
//    efficient snapshots without touching the user's index.
// 2. FILE-BASED (when workspace has no git): Copies files directly to
//    ~/.pig-agents/backups/<workspace-hash>/<checkpoint-id>/
//
// File-based backup respects common ignore patterns (node_modules, .git, etc.)

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { runGit, isRepo } from "./git.js";
import { getWorkspace } from "./workspace.js";
import { logger } from "./logger.js";
import {
  META_DIR,
  appendCheckpoint,
  deleteCheckpointRow,
  loadAllCheckpoints,
  mergeRecoveredCheckpoints,
  trimRing,
} from "./checkpointDb.js";

const REF_PREFIX = "refs/pig-agents/checkpoints/";
const MAX_KEEP = 50; // ring buffer — older checkpoints get GC'd

// Global backup directory for file-based checkpoints
const BACKUP_ROOT = path.join(os.homedir(), ".pig-agents", "backups");

// Patterns to ignore when doing file-based backup (similar to common .gitignore)
const IGNORE_PATTERNS = [
  "node_modules",
  ".git",
  ".pig-agents",
  "dist",
  "build",
  ".next",
  ".nuxt",
  "__pycache__",
  ".venv",
  "venv",
  ".env",
  ".env.local",
  "*.log",
  ".DS_Store",
  "Thumbs.db",
  "coverage",
  ".cache",
  ".parcel-cache",
  ".turbo",
];

export interface Checkpoint {
  id: string;
  workspace: string;
  label: string;
  /** When this snapshot was created (epoch ms). */
  createdAt: number;
  /** SHA of the snapshot commit pinned in `refs/pig-agents/checkpoints/<id>`. (git mode only) */
  gitSha: string;
  /** SHA of HEAD at snapshot time. (git mode only) */
  parentSha: string;
  /** Run id this snapshot belongs to. */
  runId?: string;
  /** Why we took it: explicit user click vs. auto before agent run. */
  kind: "auto-pre-run" | "auto-pre-restore" | "manual";
  /** Whether the working tree had any uncommitted changes when we snapshotted. */
  hadChanges: boolean;
  /** Backup type: git-based or file-based. */
  backupType?: "git" | "file";
  /** Path to backup directory (file mode only). */
  backupPath?: string;
}

async function ensureMetaDir(ws: string): Promise<void> {
  await fsp.mkdir(path.join(ws, META_DIR), { recursive: true });
  // Make sure git ignores our bookkeeping. We use `.git/info/exclude` rather
  // than rewriting the user's `.gitignore` so this stays invisible to them.
  try {
    const excludePath = path.join(ws, ".git", "info", "exclude");
    if (fs.existsSync(path.dirname(excludePath))) {
      let cur = "";
      try { cur = await fsp.readFile(excludePath, "utf8"); } catch { /* missing is fine */ }
      if (!cur.split(/\r?\n/).includes(`${META_DIR}/`)) {
        await fsp.writeFile(excludePath, (cur && !cur.endsWith("\n") ? cur + "\n" : cur) + `${META_DIR}/\n`);
      }
    }
  } catch (err) {
    logger.warn(`checkpoints: could not update .git/info/exclude: ${(err as Error).message}`);
  }
}

/** Persist new checkpoint + ring trim; cleans git refs / file backups for dropped entries. */
async function persistNewCheckpoint(ws: string, cp: Checkpoint): Promise<void> {
  await ensureMetaDir(ws);
  appendCheckpoint(ws, cp);
  const dropped = trimRing(ws, MAX_KEEP);
  for (const old of dropped) {
    if (old.backupType === "file" && old.backupPath) {
      await deleteFileBackup(old.backupPath);
    } else {
      await runGit(["update-ref", "-d", `${REF_PREFIX}${old.id}`], { cwd: ws });
    }
  }
}

// ---------------------------------------------------------------------------
// Snapshot construction (the heart of the engine)
// ---------------------------------------------------------------------------

/**
 * Build a tree SHA capturing the entire working tree (tracked + untracked,
 * respecting .gitignore) WITHOUT modifying the user's real index.
 *
 * Implementation uses GIT_INDEX_FILE pointing at a scratch file in the
 * system tmp dir. The scratch index is seeded by copying refs from the real
 * index file so already-tracked-but-modified content stays correct, then
 * `git add -A` brings in untracked files.
 *
 * Returns null if the workspace has no HEAD yet (truly empty repo with no
 * commits) — in that case the caller falls back to a sentinel.
 */
async function snapshotTree(ws: string): Promise<{ tree: string; hadChanges: boolean } | null> {
  const tmp = path.join(os.tmpdir(), `ba-cp-index-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    // Seed the scratch index from the real one if it exists, otherwise leave
    // empty (fresh repo case). `git read-tree HEAD` against the scratch index
    // gives us the committed-state baseline; subsequent `git add -A` layers
    // both staged and unstaged + untracked changes on top.
    const env = { GIT_INDEX_FILE: tmp };
    const headExists = (await runGit(["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: ws })).exitCode === 0;
    if (headExists) {
      const rt = await runGit(["read-tree", "HEAD"], { cwd: ws, env });
      if (rt.exitCode !== 0) {
        logger.warn(`checkpoints: scratch read-tree HEAD failed: ${rt.stderr}`);
        return null;
      }
    }
    // git add -A respects .gitignore, so node_modules / dist / .env stay out.
    const add = await runGit(["add", "-A"], { cwd: ws, env });
    if (add.exitCode !== 0) {
      logger.warn(`checkpoints: scratch add -A failed: ${add.stderr}`);
      return null;
    }
    const wt = await runGit(["write-tree"], { cwd: ws, env });
    if (wt.exitCode !== 0 || !wt.stdout.trim()) {
      logger.warn(`checkpoints: write-tree failed: ${wt.stderr}`);
      return null;
    }
    const tree = wt.stdout.trim();
    // Decide "hadChanges" by comparing snapshot tree to HEAD's tree.
    let hadChanges = true;
    if (headExists) {
      const headTree = (await runGit(["rev-parse", "HEAD^{tree}"], { cwd: ws })).stdout.trim();
      hadChanges = headTree !== tree;
    }
    return { tree, hadChanges };
  } finally {
    // Best-effort cleanup; OS will eventually clear /tmp anyway.
    try { await fsp.unlink(tmp); } catch { /* missing is fine */ }
  }
}

// ---------------------------------------------------------------------------
// File-based backup (for non-git workspaces)
// ---------------------------------------------------------------------------

function hashWorkspace(ws: string): string {
  return crypto.createHash("sha256").update(ws).digest("hex").slice(0, 16);
}

function shouldIgnore(name: string): boolean {
  for (const pattern of IGNORE_PATTERNS) {
    if (pattern.startsWith("*")) {
      // Simple wildcard suffix match
      if (name.endsWith(pattern.slice(1))) return true;
    } else if (name === pattern) {
      return true;
    }
  }
  return false;
}

/**
 * Recursively copy directory contents, respecting ignore patterns.
 */
async function copyDirRecursive(src: string, dest: string): Promise<number> {
  let fileCount = 0;
  await fsp.mkdir(dest, { recursive: true });
  
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (shouldIgnore(entry.name)) continue;
    
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    
    if (entry.isDirectory()) {
      fileCount += await copyDirRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      await fsp.copyFile(srcPath, destPath);
      fileCount++;
    }
    // Skip symlinks and other special files for safety
  }
  return fileCount;
}

/**
 * Create a file-based backup of the workspace.
 */
async function createFileBackup(ws: string, id: string): Promise<string | null> {
  const wsHash = hashWorkspace(ws);
  const backupDir = path.join(BACKUP_ROOT, wsHash, id);
  
  try {
    const fileCount = await copyDirRecursive(ws, backupDir);
    logger.info(`checkpoints: file backup created at ${backupDir} (${fileCount} files)`);
    return backupDir;
  } catch (err) {
    logger.warn(`checkpoints: file backup failed: ${(err as Error).message}`);
    // Clean up partial backup
    try { await fsp.rm(backupDir, { recursive: true, force: true }); } catch { /* ignore */ }
    return null;
  }
}

/**
 * Restore workspace from file-based backup.
 */
async function restoreFileBackup(backupPath: string, ws: string): Promise<boolean> {
  try {
    // First, remove files in workspace that will be replaced (but keep ignored ones)
    const entries = await fsp.readdir(ws, { withFileTypes: true });
    for (const entry of entries) {
      if (shouldIgnore(entry.name)) continue;
      await fsp.rm(path.join(ws, entry.name), { recursive: true, force: true });
    }
    
    // Copy backup back to workspace
    await copyDirRecursive(backupPath, ws);
    return true;
  } catch (err) {
    logger.warn(`checkpoints: file restore failed: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Delete a file-based backup.
 */
async function deleteFileBackup(backupPath: string): Promise<void> {
  try {
    await fsp.rm(backupPath, { recursive: true, force: true });
  } catch { /* ignore */ }
}

/** First line must be `ba-checkpoint:<id>`; remaining lines are the label. */
function parseCheckpointCommitMessage(body: string, expectedId: string): string {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const first = lines[0]?.trim() ?? "";
  const m = first.match(/^ba-checkpoint:(.+)$/);
  if (!m || m[1] !== expectedId) return "Recovered checkpoint";
  const rest = lines.slice(1).join("\n").trim();
  return rest || "Recovered checkpoint";
}

/**
 * If `checkpoints.json` was deleted or trimmed but git refs / file backups
 * still exist, rebuild missing rows so list/restore/delete keep working.
 */
export async function repairCheckpointMetaFromStorage(workspace?: string): Promise<number> {
  const ws = workspace ?? getWorkspace();
  const existing = loadAllCheckpoints(ws);
  const existingIds = new Set(existing.map((c) => c.id));
  const recovered: Checkpoint[] = [];

  const hasGit = await ensureRepo(ws);
  if (hasGit) {
    const refs = await runGit(["for-each-ref", "--format=%(refname)", REF_PREFIX], { cwd: ws });
    if (refs.exitCode === 0 && refs.stdout.trim()) {
      for (const line of refs.stdout.trim().split("\n")) {
        const ref = line.trim();
        if (!ref.startsWith(REF_PREFIX)) continue;
        const id = ref.slice(REF_PREFIX.length);
        if (!id || existingIds.has(id)) continue;

        const shaRes = await runGit(["rev-parse", ref], { cwd: ws });
        if (shaRes.exitCode !== 0 || !shaRes.stdout.trim()) continue;
        const gitSha = shaRes.stdout.trim();

        const bodyRes = await runGit(["log", "-1", "--format=%B", gitSha], { cwd: ws });
        const label = parseCheckpointCommitMessage(bodyRes.stdout || "", id);

        const ctRes = await runGit(["log", "-1", "--format=%ct", gitSha], { cwd: ws });
        const createdAt =
          ctRes.exitCode === 0 && /^\d+$/.test(ctRes.stdout.trim())
            ? Number(ctRes.stdout.trim()) * 1000
            : Date.now();

        const parRes = await runGit(["rev-parse", `${gitSha}^`], { cwd: ws });
        const parentSha = parRes.exitCode === 0 ? parRes.stdout.trim() : "";

        recovered.push({
          id,
          workspace: ws,
          label,
          createdAt,
          gitSha,
          parentSha,
          kind: "manual",
          hadChanges: true,
          backupType: "git",
        });
        existingIds.add(id);
      }
    }
  }

  const wsHash = hashWorkspace(ws);
  const backupBase = path.join(BACKUP_ROOT, wsHash);
  try {
    const entries = await fsp.readdir(backupBase, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory() || !ent.name.startsWith("cp-")) continue;
      const id = ent.name;
      if (existingIds.has(id)) continue;
      const backupPath = path.join(backupBase, id);
      let createdAt = Date.now();
      try {
        const st = await fsp.stat(backupPath);
        createdAt = st.mtimeMs;
      } catch {
        /* use Date.now */
      }
      recovered.push({
        id,
        workspace: ws,
        label: "Recovered checkpoint",
        createdAt,
        gitSha: "",
        parentSha: "",
        kind: "manual",
        hadChanges: true,
        backupType: "file",
        backupPath,
      });
      existingIds.add(id);
    }
  } catch {
    /* backup dir missing */
  }

  const n = mergeRecoveredCheckpoints(ws, recovered);
  if (n > 0) {
    logger.info(`checkpoints: repaired metadata (${n} row(s) from git refs / file backups)`);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * True only if the workspace is already a git repo.
 *
 * We deliberately do **not** run `git init` here — auto-creating `.git/`
 * pollutes projects the user never wanted under version control. Rollback
 * checkpoints need git; users can run `git init` themselves or use
 * `POST /git/init` / "Initialize Repository" in the UI when they want that.
 */
export async function ensureRepo(ws?: string): Promise<boolean> {
  const cwd = ws ?? getWorkspace();
  return await isRepo(cwd);
}

let counter = 0;
function makeId(): string {
  counter += 1;
  return `cp-${Date.now().toString(36)}-${counter.toString(36)}`;
}

/**
 * Create a new checkpoint of the workspace.
 * Uses git-based snapshots if available, otherwise falls back to file-based backup.
 */
export async function createCheckpoint(
  label: string,
  opts: { runId?: string; kind?: Checkpoint["kind"]; workspace?: string } = {},
): Promise<Checkpoint | null> {
  const ws = opts.workspace ?? getWorkspace();
  const id = makeId();
  const hasGit = await ensureRepo(ws);
  
  if (hasGit) {
    // Git-based checkpoint
    const snap = await snapshotTree(ws);
    if (!snap) {
      logger.warn(`checkpoints: git snapshot failed for ${id}, trying file backup`);
      return createFileCheckpoint(ws, id, label, opts);
    }

    // Get HEAD for parentage / display. Empty repo → no parent (orphan commit).
    const headRes = await runGit(["rev-parse", "HEAD"], { cwd: ws });
    const parentSha = headRes.exitCode === 0 ? headRes.stdout.trim() : "";

    const commitArgs = ["commit-tree", snap.tree, "-m", `ba-checkpoint:${id}\n${label}`];
    if (parentSha) {
      commitArgs.push("-p", parentSha);
    }
    const commit = await runGit(commitArgs, { cwd: ws });
    if (commit.exitCode !== 0 || !commit.stdout.trim()) {
      logger.warn(`checkpoints: commit-tree failed for ${id}, trying file backup`);
      return createFileCheckpoint(ws, id, label, opts);
    }
    const sha = commit.stdout.trim();

    const pin = await runGit(["update-ref", `${REF_PREFIX}${id}`, sha], { cwd: ws });
    if (pin.exitCode !== 0) {
      logger.warn(`checkpoints: update-ref failed for ${id}: ${pin.stderr}`);
      return createFileCheckpoint(ws, id, label, opts);
    }

    const cp: Checkpoint = {
      id,
      workspace: ws,
      label,
      createdAt: Date.now(),
      gitSha: sha,
      parentSha,
      runId: opts.runId,
      kind: opts.kind ?? "manual",
      hadChanges: snap.hadChanges,
      backupType: "git",
    };

    await persistNewCheckpoint(ws, cp);

    logger.info(`checkpoints: created ${id} (git, ${cp.kind}) → ${sha.slice(0, 8)}`);
    return cp;
  } else {
    // No git — use file-based backup
    return createFileCheckpoint(ws, id, label, opts);
  }
}

/**
 * Create a file-based checkpoint (fallback when git is unavailable).
 */
async function createFileCheckpoint(
  ws: string,
  id: string,
  label: string,
  opts: { runId?: string; kind?: Checkpoint["kind"] },
): Promise<Checkpoint | null> {
  const backupPath = await createFileBackup(ws, id);
  if (!backupPath) {
    logger.warn(`checkpoints: file backup also failed for ${id}`);
    return null;
  }

  const cp: Checkpoint = {
    id,
    workspace: ws,
    label,
    createdAt: Date.now(),
    gitSha: "",
    parentSha: "",
    runId: opts.runId,
    kind: opts.kind ?? "manual",
    hadChanges: true,
    backupType: "file",
    backupPath,
  };

  await persistNewCheckpoint(ws, cp);

  logger.info(`checkpoints: created ${id} (file, ${cp.kind}) → ${backupPath}`);
  return cp;
}

export async function listCheckpoints(workspace?: string): Promise<Checkpoint[]> {
  const ws = workspace ?? getWorkspace();
  await repairCheckpointMetaFromStorage(ws);
  const meta = loadAllCheckpoints(ws);
  // Filter out stale entries whose backup no longer exists.
  const result: Checkpoint[] = [];
  for (const cp of meta) {
    if (cp.backupType === "file") {
      // Check if backup directory still exists
      if (cp.backupPath && fs.existsSync(cp.backupPath)) {
        result.push(cp);
      }
    } else {
      // Git-based: check if ref exists
      const r = await runGit(["rev-parse", "--verify", "--quiet", `${REF_PREFIX}${cp.id}`], { cwd: ws });
      if (r.exitCode === 0) result.push(cp);
    }
  }
  return result.sort((a, b) => b.createdAt - a.createdAt);
}

export async function findCheckpoint(id: string, workspace?: string): Promise<Checkpoint | null> {
  const all = await listCheckpoints(workspace);
  return all.find((c) => c.id === id) ?? null;
}

/**
 * Restore the workspace to the given checkpoint. Always takes a fresh
 * "auto-pre-restore" checkpoint of the *current* state first, so even the
 * restore is itself reversible.
 *
 * Supports both git-based and file-based checkpoints.
 */
export async function restoreCheckpoint(
  id: string,
  opts: { workspace?: string } = {},
): Promise<{ ok: true; restored: Checkpoint; safetyCheckpoint: Checkpoint | null } | { ok: false; error: string }> {
  const ws = opts.workspace ?? getWorkspace();
  const cp = await findCheckpoint(id, ws);
  if (!cp) return { ok: false, error: `checkpoint not found: ${id}` };

  // Save current state for "undo my restore" before we overwrite anything.
  const safety = await createCheckpoint(`Before restoring "${cp.label}"`, {
    workspace: ws,
    kind: "auto-pre-restore",
    runId: cp.runId,
  });

  if (cp.backupType === "file") {
    // File-based restore
    if (!cp.backupPath || !fs.existsSync(cp.backupPath)) {
      return { ok: false, error: `backup directory not found: ${cp.backupPath}` };
    }
    const ok = await restoreFileBackup(cp.backupPath, ws);
    if (!ok) {
      return { ok: false, error: "file restore failed" };
    }
    logger.info(`checkpoints: restored ${cp.id} (file backup)`);
    return { ok: true, restored: cp, safetyCheckpoint: safety };
  } else {
    // Git-based restore
    const ref = `${REF_PREFIX}${cp.id}`;

    // Restore index + working tree to snapshot.
    const rt = await runGit(["read-tree", "-u", "--reset", ref], { cwd: ws });
    if (rt.exitCode !== 0) {
      return { ok: false, error: `git read-tree failed: ${rt.stderr.trim()}` };
    }
    // Remove any untracked files / dirs that exist now but didn't at snapshot.
    const clean = await runGit(["clean", "-fd"], { cwd: ws });
    if (clean.exitCode !== 0) {
      logger.warn(`checkpoints: git clean after restore reported: ${clean.stderr.trim()}`);
    }

    logger.info(`checkpoints: restored ${cp.id} (${cp.gitSha.slice(0, 8)})`);
    return { ok: true, restored: cp, safetyCheckpoint: safety };
  }
}

export async function deleteCheckpoint(id: string, workspace?: string): Promise<boolean> {
  const ws = workspace ?? getWorkspace();
  await repairCheckpointMetaFromStorage(ws);
  const meta = loadAllCheckpoints(ws);
  const idx = meta.findIndex((c) => c.id === id);
  if (idx === -1) return false;

  const cp = meta[idx];
  if (cp.backupType === "file" && cp.backupPath) {
    await deleteFileBackup(cp.backupPath);
  } else {
    await runGit(["update-ref", "-d", `${REF_PREFIX}${id}`], { cwd: ws });
  }

  return deleteCheckpointRow(ws, id);
}
