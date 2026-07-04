import path from "node:path";
import fs from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { assertPathWithinRoot, resolveRealRoot, normalizeWorkspaceRelPath } from "./pathSandbox.js";

/** Listeners are notified whenever the active workspace changes. The
 *  filesystem watcher subscribes here so it can re-target itself. We use a
 *  plain callback set instead of EventEmitter to keep this module importable
 *  from anywhere (no circular deps with the watcher module). */
const workspaceListeners = new Set<(p: string) => void>();

export function onWorkspaceChange(cb: (p: string) => void): () => void {
  workspaceListeners.add(cb);
  return () => workspaceListeners.delete(cb);
}

let currentWorkspace: string = resolveInitial();

/** Per-request workspace when the client sends `X-Build-Agents-Workspace`
 * (each browser tab can work on a different folder independently). */
const workspaceALS = new AsyncLocalStorage<string>();

/**
 * If WORKSPACE_ROOT is not set, walk up from the backend package looking for
 * a sensible project root (the first ancestor that owns either a top-level
 * `package.json` or `.git/`). This makes `npm run dev` "just work" without the
 * user having to set WORKSPACE_ROOT, and avoids defaulting to `app/backend/`.
 */
function resolveInitial(): string {
  // Desktop: never default to the bundled/dev repo tree — user picks a folder in UI.
  if (process.env.PIG_DESKTOP === "1") {
    return "";
  }
  const env = process.env.WORKSPACE_ROOT;
  if (env && env.trim().length > 0) {
    return path.resolve(env);
  }
  let dir = path.resolve(process.cwd());
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    // Prefer a package.json that is NOT just the backend's own.
    if (fs.existsSync(path.join(parent, "package.json")) && !fs.existsSync(path.join(parent, "src", "server.ts"))) {
      return parent;
    }
    dir = parent;
  }
  return path.resolve(process.cwd());
}

export function getWorkspace(): string {
  const fromReq = workspaceALS.getStore();
  if (fromReq !== undefined) return fromReq;
  return currentWorkspace;
}

/** True when `child` is `root` or nested under it. Case-insensitive on Windows. */
function isWithinDir(child: string, root: string): boolean {
  let c = path.resolve(child);
  let r = path.resolve(root);
  if (process.platform === "win32") {
    c = c.toLowerCase();
    r = r.toLowerCase();
  }
  return c === r || c.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

export function hasWorkspace(): boolean {
  return getWorkspace().trim().length > 0;
}

/**
 * Validate and canonicalize a workspace directory (exists, is dir, allowed root).
 * Used by HTTP header, POST /workspace, and WebSocket `?workspace=`.
 */
export function validateWorkspacePath(p: string): string {
  const abs = path.resolve(p);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new Error(`Not a directory: ${abs}`);
  }
  const parsed = path.parse(abs);
  const relDepth = abs
    .slice(parsed.root.length)
    .replace(/^[\\/]+/, "")
    .split(/[\\/]/)
    .filter(Boolean).length;
  if (relDepth < 1) {
    throw new Error(
      `Workspace cannot be a drive root (${parsed.root}). Pick a project folder, e.g. ${parsed.root}Projects\\my-app`,
    );
  }
  const allowed = process.env.ALLOWED_WORKSPACE_ROOT;
  if (allowed && allowed.trim().length > 0) {
    const aRoot = path.resolve(allowed);
    // Check the literal path AND its symlink/junction-resolved form: a junction
    // inside the allowed root that points outside (e.g. C:\Projects\link →
    // C:\Windows) passes a literal prefix test, but the file tools later sandbox
    // against the realpath-resolved root — so the allow-list would be defeated.
    let realAbs = abs;
    let realRoot = aRoot;
    try { realAbs = fs.realpathSync.native(abs); } catch { /* keep literal */ }
    try { realRoot = fs.realpathSync.native(aRoot); } catch { /* keep literal */ }
    if (!isWithinDir(abs, aRoot) || !isWithinDir(realAbs, realRoot)) {
      throw new Error(`Workspace ${abs} is outside ALLOWED_WORKSPACE_ROOT (${aRoot})`);
    }
  }
  return abs;
}

/** If the request includes the workspace header, return validated absolute path; else null.
 *  Accepts both `X-Pig-Agents-Workspace` (current) and legacy `X-Build-Agents-Workspace`. */
export function workspaceFromRequestHeader(req: { get(name: string): string | undefined }): string | null {
  const raw = req.get("x-pig-agents-workspace") ?? req.get("x-build-agents-workspace");
  if (!raw?.trim()) return null;
  return validateWorkspacePath(raw.trim());
}

let cachedRealRoot = "";
let cachedRealRootKey = "";

/** Canonical workspace root (symlink-resolved). Invalidated on setWorkspace. */
export function getRealWorkspaceRoot(): string {
  const ws = path.resolve(getWorkspace());
  if (cachedRealRootKey === ws && cachedRealRoot) return cachedRealRoot;
  cachedRealRootKey = ws;
  cachedRealRoot = resolveRealRoot(ws);
  return cachedRealRoot;
}

export function setWorkspace(p: string): string {
  const abs = validateWorkspacePath(p);
  currentWorkspace = abs;
  cachedRealRootKey = "";
  cachedRealRoot = "";
  for (const cb of workspaceListeners) {
    try { cb(abs); } catch { /* listener errors must not block workspace switch */ }
  }
  return currentWorkspace;
}

/**
 * Run the rest of an HTTP request with `getWorkspace()` resolved to `abs`
 * (Express middleware uses this with the header or global default).
 */
export function runWithWorkspace<T>(abs: string, fn: () => T): T {
  return workspaceALS.run(abs, fn);
}

export function safeJoin(rel: string): string {
  const rootRaw = getWorkspace();
  if (!rootRaw.trim()) {
    throw new Error("No workspace opened — open a folder first.");
  }
  const root = path.resolve(rootRaw);
  const wsReal = getRealWorkspaceRoot();
  const normRel =
    rel === "." || rel === "./"
      ? "."
      : normalizeWorkspaceRelPath(rel);
  const target = normRel === "." ? root : path.resolve(root, normRel);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`Path escapes workspace: ${rel}`);
  }
  assertPathWithinRoot(target, wsReal, normRel === "." ? "." : normRel);
  return target;
}

/** Re-check absolute path after mkdir/rename/copy (symlink targets). */
export function assertWithinWorkspaceAbs(absPath: string, relForError?: string): void {
  if (!hasWorkspace()) {
    throw new Error("No workspace opened — open a folder first.");
  }
  assertPathWithinRoot(absPath, getRealWorkspaceRoot(), relForError);
}

export { normalizeWorkspaceRelPath } from "./pathSandbox.js";

export function toRel(abs: string): string {
  const root = getWorkspace();
  return path.relative(root, abs).split(path.sep).join("/");
}
