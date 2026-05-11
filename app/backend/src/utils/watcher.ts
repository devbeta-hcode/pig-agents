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
 * Selective recursive watcher for one workspace root.
 *
 * Strategy (Linux-safe, inotify-frugal):
 *   1. Watch `root` non-recursively → catches top-level file events and new
 *      immediate subdirs appearing.
 *   2. For each immediate subdir of root that is NOT in IGNORED_SEGMENTS, add
 *      a *recursive* fs.watch on that subdir.  This skips `.git`,
 *      `node_modules`, `dist`, etc. at the inotify level (not just filtering
 *      events), which is the only reliable way to avoid ENOSPC on systems with
 *      constrained inotify limits.
 *   3. When a new top-level subdir is created, wire it up dynamically if it is
 *      not ignored.
 */
class SingleRootWatcher extends EventEmitter {
  /** Non-recursive watcher on root itself (catches top-level file events). */
  private rootWatcher: fs.FSWatcher | null = null;
  /** Recursive watchers keyed by absolute path of immediate non-ignored subdir. */
  private readonly subdirWatchers = new Map<string, fs.FSWatcher>();
  private pending = new Map<string, FsChangeEvent>();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(readonly rootAbs: string) {
    super();
    this.start();
  }

  private start(): void {
    // Step 1: non-recursive root watch
    this.rootWatcher = this.openWatch(this.rootAbs, "", false);
    // Step 2: recursive watches for non-ignored immediate subdirs
    this.scanRoot();
    logger.info(`fs watcher: watching ${this.rootAbs}`);
  }

  private openWatch(absDir: string, prefix: string, recursive: boolean): fs.FSWatcher | null {
    try {
      const w = fs.watch(absDir, { recursive, persistent: false }, (eventType, filename) => {
        const name = filename ? String(filename).split(path.sep).join("/") : "";
        const rel = prefix ? (name ? `${prefix}/${name}` : prefix) : name;
        if (rel && isIgnored(rel)) return;
        this.queue({ type: "change", path: rel, kind: eventType === "rename" ? "rename" : "change" });
        // Dynamically pick up new top-level subdirs
        if (!prefix && name && eventType === "rename") {
          const childAbs = path.join(absDir, name);
          if (this.subdirWatchers.has(childAbs)) return;
          try {
            if (fs.statSync(childAbs).isDirectory() && !isIgnored(name)) {
              const sub = this.openWatch(childAbs, name, true);
              if (sub) this.subdirWatchers.set(childAbs, sub);
            }
          } catch { /* dir may have been immediately deleted */ }
        }
      });
      w.on("error", (err) => {
        logger.warn(`fs watcher error (${absDir}): ${err.message}`);
      });
      return w;
    } catch (err) {
      logger.warn(`fs watcher: failed to watch ${absDir}: ${(err as Error).message}`);
      return null;
    }
  }

  private scanRoot(): void {
    try {
      for (const ent of fs.readdirSync(this.rootAbs, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        if (isIgnored(ent.name)) continue;
        const childAbs = path.join(this.rootAbs, ent.name);
        if (this.subdirWatchers.has(childAbs)) continue;
        const sub = this.openWatch(childAbs, ent.name, true);
        if (sub) this.subdirWatchers.set(childAbs, sub);
      }
    } catch { /* noop */ }
  }

  stop(): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    this.pending.clear();
    try { this.rootWatcher?.close(); } catch { /* noop */ }
    this.rootWatcher = null;
    for (const w of this.subdirWatchers.values()) {
      try { w.close(); } catch { /* noop */ }
    }
    this.subdirWatchers.clear();
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
