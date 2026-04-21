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
 * One recursive `fs.watch` on a single absolute root. Emits `changes` with
 * batched {@link FsChangeEvent} lists (same shape as the legacy singleton).
 */
class SingleRootWatcher extends EventEmitter {
  private watcher: fs.FSWatcher | null = null;
  private pending = new Map<string, FsChangeEvent>();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(readonly rootAbs: string) {
    super();
    this.start();
  }

  private start(): void {
    try {
      const w = fs.watch(this.rootAbs, { recursive: true, persistent: false }, (eventType, filename) => {
        const rel = filename ? String(filename).split(path.sep).join("/") : "";
        if (rel && isIgnored(rel)) return;
        this.queue({
          type: "change",
          path: rel,
          kind: eventType === "rename" ? "rename" : "change",
        });
      });
      w.on("error", (err) => {
        logger.warn(`fs watcher error (${this.rootAbs}): ${err.message}`);
      });
      this.watcher = w;
      logger.info(`fs watcher: watching ${this.rootAbs}`);
    } catch (err) {
      logger.warn(`fs watcher: failed to watch ${this.rootAbs}: ${(err as Error).message}`);
      this.watcher = null;
    }
  }

  stop(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.pending.clear();
    if (this.watcher) {
      try { this.watcher.close(); } catch { /* noop */ }
      this.watcher = null;
    }
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
  private readonly byRoot = new Map<string, SingleRootWatcher>();

  /**
   * Start watching `rootAbs` if we are not already. Safe to call on every
   * WebSocket connect — duplicate roots are ignored.
   */
  ensureWatching(rootAbs: string): void {
    const root = path.resolve(rootAbs);
    if (this.byRoot.has(root)) return;
    const inner = new SingleRootWatcher(root);
    inner.on("changes", (batch: FsChangeEvent[]) => {
      this.emit("changes", { workspace: root, changes: batch } satisfies WorkspaceChangesPayload);
    });
    this.byRoot.set(root, inner);
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
    this.byRoot.get(root)?.poke(rel);
  }
}

export const workspaceWatcher = new MultiWorkspaceWatcher();
