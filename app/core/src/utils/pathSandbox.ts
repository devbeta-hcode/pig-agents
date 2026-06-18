/**
 * Workspace path containment — resolves symlinks/junctions so tools cannot
 * escape via a link inside the project folder.
 */
import fs from "node:fs";
import path from "node:path";

/** Canonical absolute workspace root (follows symlinks on the root itself). */
export function resolveRealRoot(ws: string): string {
  const abs = path.resolve(ws);
  try {
    return fs.realpathSync.native(abs);
  } catch {
    return abs;
  }
}

function sameOrUnder(resolved: string, root: string): boolean {
  if (resolved === root) return true;
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved.startsWith(prefix)) return true;
  if (process.platform === "win32") {
    const r = resolved.toLowerCase();
    const w = root.toLowerCase();
    return r === w || r.startsWith(w + path.sep);
  }
  return false;
}

/**
 * True when `absPath` resolves (via realpath on existing segments) to the
 * workspace root or a path beneath it.
 */
export function isPathWithinRoot(absPath: string, wsRoot: string): boolean {
  const root = path.resolve(wsRoot);
  const target = path.resolve(absPath);

  if (!sameOrUnder(target, root)) return false;

  try {
    if (fs.existsSync(target)) {
      const real = fs.realpathSync.native(target);
      return sameOrUnder(real, root);
    }

    // New file/dir: verify nearest existing ancestor stays inside workspace.
    let dir = target;
    while (!fs.existsSync(dir)) {
      const parent = path.dirname(dir);
      if (parent === dir) return sameOrUnder(dir, root);
      dir = parent;
    }
    const realDir = fs.realpathSync.native(dir);
    return sameOrUnder(realDir, root);
  } catch {
    return false;
  }
}

export function assertPathWithinRoot(absPath: string, wsRoot: string, relForError?: string): string {
  const target = path.resolve(absPath);
  if (!isPathWithinRoot(target, wsRoot)) {
    throw new Error(`Path escapes workspace: ${relForError ?? target}`);
  }
  return target;
}

/**
 * Normalize and validate a workspace-relative path for Explorer + agent file tools.
 * Rejects absolute paths, `..`, wildcards, and NUL/newlines.
 */
export function normalizeWorkspaceRelPath(raw: string, opts?: { allowDot?: boolean }): string {
  const p = String(raw ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  if (!p || p === ".") {
    if (opts?.allowDot) return ".";
    throw new Error("Path is required (workspace-relative, e.g. src/app.ts)");
  }
  if (/[\0\r\n]/.test(p)) {
    throw new Error("Invalid path: control characters are not allowed");
  }
  if (/[*?[\]{}]/.test(p) || p.includes("**")) {
    throw new Error(`Wildcards are not allowed in path: ${p}`);
  }
  if (/(^|\/)\.\.(\/|$)/.test(p)) {
    throw new Error("'..' is not allowed — path must stay inside the workspace");
  }
  if (/^[A-Za-z]:[/\\]?/.test(p) || p.startsWith("\\\\") || p.startsWith("//")) {
    throw new Error("Use workspace-relative path only, not an absolute path");
  }
  if (p.includes(":")) {
    throw new Error("Invalid path character ':'");
  }
  return p;
}

/** Extract Windows/UNC absolute path literals from a shell command string. */
export function extractAbsolutePathLiterals(cmd: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const push = (raw: string | undefined) => {
    if (!raw) return;
    const p = raw.trim();
    if (!p || seen.has(p)) return;
    seen.add(p);
    out.push(p);
  };

  // Quoted paths
  for (const m of cmd.matchAll(/"([A-Za-z]:[^"]*)"|'([A-Za-z]:[^']*)'/g)) {
    push(m[1] ?? m[2]);
  }
  for (const m of cmd.matchAll(/"(\\\\[^"]+)"|'(\\\\[^']+)'/g)) {
    push(m[1] ?? m[2]);
  }

  // Unquoted C:\... or \\server\share\...
  for (const m of cmd.matchAll(/(?:^|[\s;|&()])([A-Za-z]:[\\/][^\s"'|&;<>]+|\\\\[^\s"'|&;<>]+)/g)) {
    push(m[1]);
  }

  return out;
}

function looksAbsolutePath(p: string): boolean {
  const t = p.trim();
  return /^[A-Za-z]:[\\/]/.test(t) || t.startsWith("\\\\");
}

/**
 * Block shell commands that cd or reference absolute paths outside workspace.
 * Relative paths only — cwd is always WORKSPACE_PATH.
 */
export function rejectShellPathsOutsideWorkspace(cmd: string, workspace: string): string | null {
  const wsRoot = resolveRealRoot(workspace);
  const trimmed = cmd.trim();

  const cdPatterns: RegExp[] = [
    /\b(?:cd|chdir)\s+\/d\s+("?)([^"&|;\r\n]+)\1/i,
    /\b(?:cd|chdir)\s+("?)([^"&|;\r\n]+)\1/i,
    /\bSet-Location\s+(?:-(?:Literal)?Path\s+)?("?)([^"&|;\r\n]+)\1/i,
  ];
  for (const re of cdPatterns) {
    const m = re.exec(trimmed);
    if (!m) continue;
    const target = m[2].trim();
    if (!looksAbsolutePath(target)) continue;
    const abs = path.resolve(target);
    if (!isPathWithinRoot(abs, wsRoot)) {
      return (
        `Blocked: cd/Set-Location outside workspace (${target}). ` +
        `run_command cwd is WORKSPACE_PATH — use relative paths only.`
      );
    }
  }

  for (const raw of extractAbsolutePathLiterals(trimmed)) {
    const abs = path.resolve(raw);
    if (!isPathWithinRoot(abs, wsRoot)) {
      return (
        `Blocked: absolute path outside workspace in run_command: ${raw}. ` +
        `Use workspace-relative paths only (delete_path for deletes).`
      );
    }
  }

  return null;
}
