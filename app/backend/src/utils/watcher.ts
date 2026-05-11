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
 * Shallow two-level watcher: one non-recursive watch on root, plus one
 * non-recursive watch per immediate non-ignored subdir.
 *
 * Why non-recursive everywhere:
 *   On Linux, `fs.watch({ recursive: true })` calls `inotify_add_watch` for
 *   every nested subdirectory it traverses, consuming one entry from
 *   `max_user_watches` per directory.  Large workspaces (Android, monorepos)
 *   exhaust this budget quickly and produce ENOSPC errors.  By limiting to
 *   two levels and skipping ignored segments at the inotify level (not just
 *   in the event callback), we cap total watches at roughly
 *   1 + |non-ignored immediate subdirs| — typically < 50.
 *
 *   Trade-off: changes deeper than two levels only propagate the closest
 *   ancestor path the watcher knows about.  The file-tree UI refreshes
 *   lazily anyway, so this is acceptable.
 */
class SingleRootWatcher extends EventEmitter {
  /** All active non-recursive watchers keyed by absolute directory path. */
  private readonly watchers = new Map<string, fs.FSWatcher>();
  private pending = new Map<string, FsChangeEvent>();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(readonly rootAbs: string) {
    super();
    this.start();
  }

  private start(): void {
    this.addWatch(this.rootAbs, "");
    try {
      for (const ent of fs.readdirSync(this.rootAbs, { withFileTypes: true })) {
        if (!ent.isDirectory() || isIgnored(ent.name)) continue;
        this.addWatch(path.join(this.rootAbs, ent.name), ent.name);
      }
    } catch { /* permission denied, skip */ }
    logger.info(`fs watcher: watching ${this.rootAbs} (${this.watchers.size} watches)`);
  }

  private addWatch(absDir: string, prefix: string): void {
    if (this.watchers.has(absDir)) return;
    try {
      const w = fs.watch(absDir, { recursive: false, persistent: false }, (eventType, filename) => {
        const name = filename ? String(filename).split(path.sep).join("/") : "";
        const rel = prefix ? (name ? `${prefix}/${name}` : prefix) : name;
        if (rel && isIgnored(rel)) return;
        this.queue({ type: "change", path: rel, kind: eventType === "rename" ? "rename" : "change" });
        // When a new immediate subdir of root appears, start watching it too.
        if (!prefix && name && eventType === "rename") {
          const childAbs = path.join(absDir, name);
          if (this.watchers.has(childAbs)) return;
          try {
            if (fs.statSync(childAbs).isDirectory() && !isIgnored(name)) {
              this.addWatch(childAbs, name);
            }
          } catch { /* dir was immediately deleted */ }
        }
      });
      w.on("error", (err) => {
        logger.warn(`fs watcher error (${absDir}): ${err.message}`);
        this.watchers.delete(absDir);
      });
      this.watchers.set(absDir, w);
    } catch (err) {
      logger.warn(`fs watcher: failed to watch ${absDir}: ${(err as Error).message}`);
    }
  }

  stop(): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    this.pending.clear();
    for (const w of this.watchers.values()) {
      try { w.close(); } catch { /* noop */ }
    }
    this.watchers.clear();
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
