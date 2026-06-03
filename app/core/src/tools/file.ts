import fs from "node:fs/promises";
import fssync from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { safeJoin, toRel } from "../utils/workspace.js";
import { workspaceWatcher } from "../utils/watcher.js";
import { isWindows } from "../utils/shell.js";
import { cleanupAllBackgroundProcesses } from "./smartCommand.js";
import { windowsClearAttributesRecursive, windowsReleasePathLocks } from "./windowsDelete.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function formatDeleteError(rel: string, err: unknown): Error {
  const e = err as NodeJS.ErrnoException;
  const code = e?.code ?? "";
  const msg = e?.message ?? String(err);
  const target = e?.path ?? rel;
  if (code === "EBUSY" || /EBUSY|resource busy|locked/i.test(msg)) {
    return new Error(
      `Cannot delete "${rel}": path is in use (EBUSY on Windows).\n` +
        `• Stop agent runs and close Terminals tabs (especially npm run dev in this folder)\n` +
        `• Close editor tabs for files inside "${rel}"\n` +
        `• Close File Explorer windows showing this folder\n` +
        `• Retry after a few seconds\n` +
        `Path: ${target}`,
    );
  }
  if (code === "EPERM" || code === "EACCES" || /access is denied/i.test(msg)) {
    return new Error(
      `Cannot delete "${rel}": permission denied (${code || "access denied"}).\n` +
        `On Windows, stop Vite/npm dev servers first (they lock esbuild.exe and rollup binaries in node_modules).\n` +
        `Close Pig Agents Terminals tabs, stop the agent run, then retry.\n` +
        `Path: ${target}`,
    );
  }
  if (code === "ENOTEMPTY") {
    return new Error(`Cannot delete "${rel}": directory not empty (${code}). Path: ${target}`);
  }
  return new Error(`Cannot delete "${rel}": ${msg}`);
}

/** Skipped when walking the tree for `searchCode` only (avoids scanning huge deps trees). */
const SEARCH_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  ".venv",
  "__pycache__",
]);

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size?: number;
  mtimeMs?: number;
}

export async function listFiles(rel: string = "."): Promise<FileEntry[]> {
  const abs = safeJoin(rel);
  let dirents: import("fs").Dirent[];
  try {
    dirents = await fs.readdir(abs, { withFileTypes: true });
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw err;
  }
  // Fan out stat() calls in parallel so a folder with hundreds of children
  // resolves in roughly one round-trip instead of N sequential awaits. The
  // dirent already tells us isDir/isFile, so stat is only needed for size +
  // mtime; failures degrade to "no stat info" instead of dropping the entry.
  const entries: (FileEntry | null)[] = await Promise.all(
    dirents.map(async (d) => {
      const isDir = d.isDirectory();
      const full = path.join(abs, d.name);
      let size: number | undefined;
      let mtimeMs: number | undefined;
      try {
        const stat = await fs.stat(full);
        if (!isDir) size = stat.size;
        mtimeMs = stat.mtimeMs;
      } catch {
        // Symlink to nowhere / EACCES — keep the entry visible without stat.
      }
      return {
        name: d.name,
        path: toRel(full),
        isDir,
        size,
        mtimeMs,
      };
    }),
  );
  const out = entries.filter((e): e is FileEntry => e !== null);
  out.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return out;
}

export async function readFile(rel: string): Promise<string> {
  const abs = safeJoin(rel);
  const stat = await fs.stat(abs);
  if (stat.isDirectory()) throw new Error(`Is a directory: ${rel}`);
  if (stat.size > 5 * 1024 * 1024) throw new Error(`File too large (>5MB): ${rel}`);
  return await fs.readFile(abs, "utf8");
}

/** Slice file content by 1-based line numbers (inclusive). */
export function sliceFileLines(
  content: string,
  startLine?: number,
  endLine?: number,
): { text: string; totalLines: number; from: number; to: number } {
  const lines = content.split(/\r?\n/);
  const total = lines.length;
  let from = 1;
  let to = total;
  if (startLine != null && Number.isFinite(startLine)) {
    from = Math.max(1, Math.min(total, Math.floor(startLine)));
  }
  if (endLine != null && Number.isFinite(endLine)) {
    to = Math.max(from, Math.min(total, Math.floor(endLine)));
  }
  const maxLines = 200;
  if (to - from + 1 > maxLines) {
    to = from + maxLines - 1;
  }
  const text = lines.slice(from - 1, to).join("\n");
  return { text, totalLines: total, from, to };
}

/** Short manifest excerpts for first-turn agent context (Aider-style). */
export async function buildManifestExcerpt(maxLinesPerFile = 28): Promise<string> {
  const parts: string[] = [];
  let total = 0;
  const maxTotal = 4500;
  for (const p of MANIFEST_HINTS) {
    if (total >= maxTotal) break;
    try {
      const content = await readFile(p);
      const lines = content.split(/\r?\n/);
      const excerpt = lines.slice(0, maxLinesPerFile).join("\n");
      const block = `--- ${p} ---\n${excerpt}${lines.length > maxLinesPerFile ? "\n…" : ""}`;
      parts.push(block);
      total += block.length;
    } catch {
      /* missing */
    }
  }
  return parts.length ? parts.join("\n\n") : "";
}

export async function writeFile(rel: string, content: string): Promise<void> {
  const abs = safeJoin(rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}

export async function createEntry(rel: string, kind: "file" | "dir"): Promise<void> {
  const abs = safeJoin(rel);
  if (kind === "dir") {
    await fs.mkdir(abs, { recursive: true });
  } else {
    await fs.mkdir(path.dirname(abs), { recursive: true });
    if (!fssync.existsSync(abs)) await fs.writeFile(abs, "", "utf8");
  }
}

function windowsCmdRmdir(abs: string): boolean {
  const quoted = `"${abs.replace(/"/g, '""')}"`;
  const r = spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `rd /s /q ${quoted}`], {
    stdio: "ignore",
    timeout: 120_000,
  });
  return r.status === 0 || !fssync.existsSync(abs);
}

function releaseLocksForDelete(abs: string): void {
  try {
    cleanupAllBackgroundProcesses();
  } catch {
    /* noop */
  }
  if (isWindows) {
    windowsReleasePathLocks(abs);
    windowsClearAttributesRecursive(abs);
  }
}

async function deleteEntryAttempts(abs: string, rel: string): Promise<void> {
  releaseLocksForDelete(abs);

  const backoffMs = [0, 400, 1000, 2000, 3500];
  let lastErr: unknown;
  for (let attempt = 0; attempt < backoffMs.length; attempt++) {
    if (backoffMs[attempt] > 0) await sleep(backoffMs[attempt]);
    if (attempt === 2) releaseLocksForDelete(abs);
    try {
      await fs.rm(abs, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      });
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") {
        throw formatDeleteError(rel, err);
      }
    }
  }

  if (isWindows && fssync.existsSync(abs)) {
    releaseLocksForDelete(abs);
    try {
      const trash = path.join(os.tmpdir(), `.pig-del-${process.pid}-${Date.now()}`);
      await fs.rename(abs, trash);
      releaseLocksForDelete(trash);
      await fs.rm(trash, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
      return;
    } catch {
      /* rename-away failed — try cmd rd */
    }
    releaseLocksForDelete(abs);
    if (windowsCmdRmdir(abs)) return;
  }

  throw formatDeleteError(rel, lastErr);
}

export async function deleteEntry(rel: string): Promise<void> {
  const abs = safeJoin(rel);
  const wsRoot = path.resolve(safeJoin("."));

  const resumeWatch = workspaceWatcher.pauseWatching(wsRoot);
  try {
    await deleteEntryAttempts(abs, rel);
  } finally {
    resumeWatch();
  }
}

/**
 * Copy a file or directory. If the destination already exists, derive a
 * non-conflicting name by suffixing " copy", " copy 2", … (before the
 * extension for files), VSCode-style. Returns the workspace-relative final
 * destination path so the client can refresh + reveal it.
 */
export async function copyEntry(fromRel: string, toRel: string): Promise<string> {
  const fromAbs = safeJoin(fromRel);
  const toAbsRequested = safeJoin(toRel);
  const stat = await fs.stat(fromAbs);
  await fs.mkdir(path.dirname(toAbsRequested), { recursive: true });
  const finalAbs = await uniquePath(toAbsRequested, stat.isDirectory());
  await fs.cp(fromAbs, finalAbs, { recursive: true, errorOnExist: false, force: false });
  return toRelClean(finalAbs);
}

async function uniquePath(target: string, isDir: boolean): Promise<string> {
  if (!fssync.existsSync(target)) return target;
  const dir = path.dirname(target);
  const base = path.basename(target);
  let stem = base;
  let ext = "";
  if (!isDir) {
    const dot = base.lastIndexOf(".");
    if (dot > 0) { stem = base.slice(0, dot); ext = base.slice(dot); }
  }
  for (let i = 1; i < 1000; i++) {
    const suffix = i === 1 ? " copy" : ` copy ${i}`;
    const candidate = path.join(dir, `${stem}${suffix}${ext}`);
    if (!fssync.existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not derive a unique name for ${base}`);
}

function toRelClean(abs: string): string {
  return toRel(abs);
}

export async function searchCode(query: string, max = 50): Promise<{ file: string; line: number; text: string }[]> {
  const results: { file: string; line: number; text: string }[] = [];
  const root = safeJoin(".");
  const q = query.toLowerCase();

  async function walk(dir: string) {
    if (results.length >= max) return;
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    for (const d of dirents) {
      if (results.length >= max) return;
      if (SEARCH_SKIP_DIRS.has(d.name)) continue;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) {
        await walk(full);
      } else if (d.isFile()) {
        try {
          const stat = await fs.stat(full);
          if (stat.size > 1024 * 1024) continue;
          const text = await fs.readFile(full, "utf8");
          const lines = text.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase().includes(q)) {
              results.push({ file: toRel(full), line: i + 1, text: lines[i].slice(0, 240) });
              if (results.length >= max) return;
            }
          }
        } catch {
          // ignore unreadable files (binaries)
        }
      }
    }
  }

  await walk(root);
  return results;
}

export async function fileTree(rel: string = ".", depth = 4): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  async function walk(r: string, d: number) {
    if (d < 0) return;
    const items = await listFiles(r);
    for (const it of items) {
      out.push(it);
      if (it.isDir) await walk(it.path, d - 1);
    }
  }
  await walk(rel, depth);
  return out;
}

/** Dirs skipped in codebase_map (heavy or internal). */
const CODEBASE_MAP_SKIP = new Set([
  ...SEARCH_SKIP_DIRS,
  ".pig-agents",
]);

const MANIFEST_HINTS = [
  "AGENTS.md",
  "README.md",
  "README",
  "package.json",
  "Cargo.toml",
  "pyproject.toml",
  "go.mod",
  "index.html",
  "style.css",
  "script.js",
] as const;

/**
 * Workspace “index”: indented tree + short excerpts from common manifest files.
 * Gives the agent a map before diving into random files.
 */
export async function buildCodebaseMapSummary(opts: {
  maxDepth?: number;
  maxTreeLines?: number;
}): Promise<string> {
  const maxDepth = Math.min(10, Math.max(1, Math.floor(opts.maxDepth ?? 5)));
  const maxTreeLines = Math.min(1000, Math.max(40, Math.floor(opts.maxTreeLines ?? 450)));
  const lines: string[] = [];
  let lineCount = 0;

  async function walk(rel: string, currentDepth: number, prefix: string): Promise<void> {
    if (lineCount >= maxTreeLines) return;
    let items: FileEntry[];
    try {
      items = await listFiles(rel);
    } catch {
      return;
    }
    for (const it of items) {
      if (lineCount >= maxTreeLines) return;
      if (CODEBASE_MAP_SKIP.has(it.name)) continue;
      const label = it.isDir ? `${it.name}/` : it.name;
      lines.push(`${prefix}${label}`);
      lineCount++;
      if (it.isDir && currentDepth < maxDepth) {
        await walk(it.path, currentDepth + 1, `${prefix}  `);
      }
    }
  }

  await walk(".", 0, "");
  const treeBlock =
    lines.length === 0
      ? "(empty workspace)"
      : lines.join("\n");

  const hintParts: string[] = [];
  let hintsLen = 0;
  const maxHintsTotal = 7000;
  const maxLinesPerFile = 42;

  for (const p of MANIFEST_HINTS) {
    if (hintsLen >= maxHintsTotal) break;
    try {
      const content = await readFile(p);
      const fileLines = content.split(/\r?\n/);
      const excerpt = fileLines.slice(0, maxLinesPerFile).join("\n");
      const tail = fileLines.length > maxLinesPerFile ? "\n…" : "";
      const block = `--- ${p} (${fileLines.length} lines) — excerpt ---\n${excerpt}${tail}`;
      hintParts.push(block);
      hintsLen += block.length;
    } catch {
      /* missing */
    }
  }

  const hintsBlock =
    hintParts.length === 0
      ? "(no AGENTS.md / README / package.json / … at repo root)"
      : hintParts.join("\n\n");

  return (
    `## Directory tree (depth ≤ ${maxDepth}, build/node_modules/git/… skipped)\n${treeBlock}\n\n` +
    `## Project manifests (root excerpts)\n${hintsBlock}`
  );
}

/**
 * Lightweight directory tree for embedding in agent context messages.
 * No manifest excerpts — just the indented path tree. Much cheaper than
 * buildCodebaseMapSummary; lets the agent skip codebase_map for orientation.
 */
export async function buildCompactTree(maxDepth = 3, maxLines = 200): Promise<string> {
  const lines: string[] = [];
  let count = 0;

  async function walk(rel: string, depth: number, prefix: string): Promise<void> {
    if (count >= maxLines) return;
    let items: FileEntry[];
    try {
      items = await listFiles(rel);
    } catch {
      return;
    }
    for (const it of items) {
      if (count >= maxLines) return;
      if (CODEBASE_MAP_SKIP.has(it.name)) continue;
      lines.push(`${prefix}${it.isDir ? it.name + "/" : it.name}`);
      count++;
      if (it.isDir && depth < maxDepth) {
        await walk(it.path, depth + 1, prefix + "  ");
      }
    }
  }

  await walk(".", 0, "");
  if (lines.length === 0) return "(empty)";
  return lines.join("\n") + (count >= maxLines ? "\n…(tree truncated)" : "");
}

/**
 * Glob-style file search. Supports `*` (any segment chars) and `**` (any path depth).
 * Returns workspace-relative paths. Skips node_modules/.git/dist/build.
 */
export async function globFiles(pattern: string, maxResults = 500): Promise<string[]> {
  const root = safeJoin(".");
  const results: string[] = [];

  // Convert glob pattern to a RegExp.
  function globToRegex(glob: string): RegExp {
    // Escape regex metacharacters except * and ?
    const escaped = glob
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "\u0001") // placeholder for **
      .replace(/\*/g, "[^/]*")    // * matches within a segment
      .replace(/\?/g, "[^/]")     // ? matches single non-sep char
      .replace(/\u0001/g, ".*");  // ** matches any path
    return new RegExp(`^${escaped}$`, "i");
  }

  const re = globToRegex(pattern);

  async function walk(dir: string): Promise<void> {
    if (results.length >= maxResults) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of entries) {
      if (results.length >= maxResults) return;
      if (SEARCH_SKIP_DIRS.has(d.name)) continue;
      const fullAbs = path.join(dir, d.name);
      const rel = toRel(fullAbs);
      if (d.isDirectory()) {
        await walk(fullAbs);
      } else {
        if (re.test(rel)) results.push(rel);
      }
    }
  }

  await walk(root);
  return results;
}
