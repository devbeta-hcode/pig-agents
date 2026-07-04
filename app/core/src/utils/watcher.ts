import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { getWorkspace } from "./workspace.js";
import { logger } from "./logger.js";

/**
 * Filesystem change event broadcast to all subscribers.
 *
 * `path` is workspace-relative (POSIX-style). It may be empty for
 * coalesced "something happened" events when the OS gave us no specific path
 * (Linux `fs.watch` recursive sometimes does this).
 */
export interface FsChangeEvent {
  type: "change";
  /** Workspace-relative POSIX path. May be "" when the OS didn't tell us. */
  path: string;
  /** "rename" covers create + delete + move on most platforms. */
  kind: "rename" | "change";
}

export interface WorkspaceChangesPayload {
  /** Absolute workspace root this batch belongs to. */
  workspace: string;
  changes: FsChangeEvent[];
}

/**
 * Path segments we never want to surface as filesystem changes. These tend
 * to churn dramatically (build outputs, dep installs, git internals) and
 * cause the file tree to refresh hundreds of times per second for nothing
 * the user cares about.
 */
const IGNORED_SEGMENTS = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  ".cache",
  ".parcel-cache",
  ".vite",
  ".pytest_cache",
  "__pycache__",
  ".mypy_cache",
  ".tox",
  ".venv",
  "venv",
  "target",
  "coverage",
  ".nyc_output",
  ".idea",
  ".vscode-test",
]);

function isIgnored(rel: string): boolean {
  if (!rel) return false;
  for (const seg of rel.split("/")) {
    if (IGNORED_SEGMENTS.has(seg)) return true;
  }
  return false;
}

const debounceMs = 200;

/**
 * Single-fd root watcher.
 *
 * Uses exactly ONE inotify fd (one FSWatcher) per workspace, watching
 * only the root directory non-recursively.  This is the only design that
 * never hits `max_user_instances` (default 128 on Linux) regardless of
 * workspace size or how many other processes (VSCode, vite, …) are open.
 *
 * Trade-off: events from files nested deeper than the root only carry the
 * root-level path component.  The file-tree UI triggers explicit API list
 * calls on any change, so this is acceptable.
 */
class SingleRootWatcher extends EventEmitter {
  private watcher: fs.FSWatcher | null = null;
  private active = false;
  private pending = new Map<string, FsChangeEvent>();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(readonly rootAbs: string) {
    super();
    this.start();
  }

  private start(): boolean {
    try {
      // Windows + macOS support native recursive watching (ReadDirectoryChangesW
      // / FSEvents) from a SINGLE handle, so subdirectory writes (js/app.js,
      // css/x.css, …) fire too and the file tree updates live. Linux recursive
      // watch is fd-hungry (max_user_instances) — keep it non-recursive there.
      const recursive = process.platform === "win32" || process.platform === "darwin";
      const w = fs.watch(this.rootAbs, { recursive, persistent: false }, (eventType, filename) => {
        const name = filename ? String(filename).split(path.sep).join("/") : "";
        if (name && isIgnored(name)) return;
        this.queue({ type: "change", path: name, kind: eventType === "rename" ? "rename" : "change" });
      });
      w.on("error", (err) => {
        logger.warn(`fs watcher error (${this.rootAbs}): ${err.message}`);
      });
      this.watcher = w;
      this.active = true;
      logger.info(`fs watcher: watching ${this.rootAbs}`);
      return true;
    } catch (err) {
      this.active = false;
      logger.warn(`fs watcher: failed to watch ${this.rootAbs}: ${(err as Error).message}`);
      return false;
    }
  }

  stop(): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    this.pending.clear();
    try { this.watcher?.close(); } catch { /* noop */ }
    this.watcher = null;
    this.active = false;
  }

  isActive(): boolean {
    return this.active;
  }

  poke(rel = ""): void {
    this.queue({ type: "change", path: rel, kind: "change" });
  }

  private queue(ev: FsChangeEvent): void {
    const key = ev.path || "*";
    this.pending.set(key, ev);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), debounceMs);
  }

  private flush(): void {
    this.flushTimer = null;
    if (this.pending.size === 0) return;
    const batch = [...this.pending.values()];
    this.pending.clear();
    this.emit("changes", batch);
  }
}

/**
 * Holds one {@link SingleRootWatcher} per absolute workspace root so multiple
 * browser tabs (different folders) can share the backend without fighting
 * over a single `fs.watch`.
 */
class MultiWorkspaceWatcher extends EventEmitter {
  private readonly byRoot = new Map<string, { watcher: SingleRootWatcher; refs: number }>();

  /**
   * Start watching `rootAbs` if we are not already. Safe to call on every
   * WebSocket connect — duplicate roots are ignored.
   */
  ensureWatching(rootAbs: string): () => void {
    const root = path.resolve(rootAbs);
    const existing = this.byRoot.get(root);
    if (existing) {
      existing.refs += 1;
      return () => this.release(root);
    }

    const inner = new SingleRootWatcher(root);
    if (!inner.isActive()) {
      return () => { /* noop */ };
    }

    inner.on("changes", (batch: FsChangeEvent[]) => {
      this.emit("changes", { workspace: root, changes: batch } satisfies WorkspaceChangesPayload);
    });
    this.byRoot.set(root, { watcher: inner, refs: 1 });
    return () => this.release(root);
  }

  private release(root: string): void {
    const existing = this.byRoot.get(root);
    if (!existing) return;
    existing.refs -= 1;
    if (existing.refs > 0) return;
    existing.watcher.stop();
    existing.watcher.removeAllListeners();
    this.byRoot.delete(root);
  }

  /**
   * Watch the server's default workspace (and keep watching it after global
   * workspace changes via {@link onWorkspaceChange}).
   */
  start(): void {
    this.ensureWatching(getWorkspace());
  }

  /**
   * Force a "something changed" tick on a specific root (used when the OS
   * watcher might miss an event).
   */
  poke(rootAbs: string, rel = ""): void {
    const root = path.resolve(rootAbs);
    this.byRoot.get(root)?.watcher.poke(rel);
  }

  /**
   * Close the OS handle while deleting paths under this workspace (Windows EBUSY).
   * Call the returned function to re-arm the watcher when delete finishes.
   */
  pauseWatching(rootAbs: string): () => void {
    const root = path.resolve(rootAbs);
    const entry = this.byRoot.get(root);
    if (!entry) return () => {};
    entry.watcher.stop();
    return () => {
      const cur = this.byRoot.get(root);
      if (!cur || cur.refs <= 0) return;
      const inner = new SingleRootWatcher(root);
      if (!inner.isActive()) return;
      inner.on("changes", (batch: FsChangeEvent[]) => {
        this.emit("changes", { workspace: root, changes: batch } satisfies WorkspaceChangesPayload);
      });
      cur.watcher = inner;
    };
  }
}

export const workspaceWatcher = new MultiWorkspaceWatcher();
