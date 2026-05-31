import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronExpand } from "./ChevronExpand";
import { FileIcon } from "./FileIcon";
import { api, type GitFileEntry, type GitLogEntry, type GitStatus } from "../lib/api";
import { useDialogs } from "./DialogProvider";
import { IconCheck, IconRefreshCw, IconRotateCcw } from "./Icons";

// VSCode-style colors for the status badge (M / A / D / U / R …). Kept in
// sync with the codes git emits in `--porcelain=v1`. The fallback is a
// neutral gray so we never render a colorless tag.
const STATUS_COLORS: Record<string, string> = {
  M: "#e2c08d", // Modified — VSCode yellow-orange
  A: "#81b88b", // Added (staged) — green
  D: "#c74e39", // Deleted — red
  R: "#73c991", // Renamed
  C: "#73c991", // Copied
  T: "#e2c08d", // Type change
  U: "#73c991", // Untracked
  "?": "#73c991",
  "!": "#9d9d9d",
};

const STATUS_LABELS: Record<string, string> = {
  M: "Modified",
  A: "Added",
  D: "Deleted",
  R: "Renamed",
  C: "Copied",
  T: "Type changed",
  U: "Untracked",
  "?": "Untracked",
  "!": "Ignored",
};

interface GitDiffOpenRequest {
  path: string;
  staged: boolean;
  untracked: boolean;
  diff: string;
}

interface Props {
  workspace: string;
  /**
   * Open a unified diff in the main editor area as a diff tab. The host
   * provides the actual openTab plumbing — we just hand back the diff text
   * and metadata.
   */
  onOpenGitDiff: (req: GitDiffOpenRequest) => void;
  /** Bumped externally whenever the editor saves — triggers a refresh. */
  refreshKey?: number;
}

export function GitPanel({ workspace, onOpenGitDiff, refreshKey }: Props) {
  const dlg = useDialogs();
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [log, setLog] = useState<GitLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [committing, setCommitting] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const refresh = useCallback(async () => {
    if (!workspace) return;
    setLoading(true);
    setError(null);
    try {
      const [s, l] = await Promise.all([
        api.gitStatus(),
        api.gitLog(50).catch(() => ({ ok: false, entries: [] as GitLogEntry[] })),
      ]);
      setStatus(s);
      setLog(l.entries || []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [workspace]);

  useEffect(() => { void refresh(); }, [refresh, refreshKey]);

  // Background polling intentionally NOT done here — App.tsx already heart-
  // beats `gitStatus` every 10s for the activity-bar badge, and the FS
  // watcher bumps `refreshKey` on disk changes (CLI commits, rebase, etc.)
  // which feeds straight into the effect above. A second timer here was
  // redundant load + extra commits that fought with chat streaming.

  const staged = useMemo(() => (status?.files ?? []).filter((f) => f.staged && !f.untracked), [status]);
  const unstaged = useMemo(
    () => (status?.files ?? []).filter((f) => !f.staged && !f.untracked && f.unstaged),
    [status],
  );
  const untracked = useMemo(() => (status?.files ?? []).filter((f) => f.untracked), [status]);
  const totalChanges = staged.length + unstaged.length + untracked.length;

  async function viewDiff(file: GitFileEntry) {
    try {
      const r = await api.gitDiff(file.path, {
        staged: file.staged && !file.unstaged && !file.untracked,
        untracked: file.untracked,
      });
      onOpenGitDiff({
        path: file.path,
        staged: r.staged,
        untracked: r.untracked,
        diff: r.diff,
      });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function stage(paths: string[]) {
    setWorking(true);
    try { await api.gitStage(paths); await refresh(); }
    catch (e) { setError((e as Error).message); }
    finally { setWorking(false); }
  }
  async function unstage(paths: string[]) {
    setWorking(true);
    try { await api.gitUnstage(paths); await refresh(); }
    catch (e) { setError((e as Error).message); }
    finally { setWorking(false); }
  }
  async function discard(paths: string[]) {
    if (!(await dlg.confirm({
      title: "Discard changes",
      message: `Discard local changes to:\n\n${paths.join("\n")}\n\nThis cannot be undone.`,
      danger: true,
      confirmLabel: "Discard",
    }))) return;
    setWorking(true);
    try { await api.gitDiscard(paths); await refresh(); }
    catch (e) { setError((e as Error).message); }
    finally { setWorking(false); }
  }

  async function doCommit(opts?: { stageAll?: boolean }) {
    if (!message.trim()) return;
    setCommitting(true);
    setError(null);
    try {
      await api.gitCommit(message.trim(), { stageAll: opts?.stageAll });
      setMessage("");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCommitting(false);
    }
  }

  function onMessageKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void doCommit();
    }
  }

  // Empty workspace
  if (!workspace) {
    return (
      <div className="git-panel">
        <div className="git-section-title">SOURCE CONTROL</div>
        <div className="git-empty">No folder opened. Pick a workspace to see git changes.</div>
      </div>
    );
  }

  // Not a git repo — offer to init
  if (status && status.ok === false && status.reason === "not_a_repo") {
    return (
      <div className="git-panel">
        <div className="git-section-title">SOURCE CONTROL</div>
        <div className="git-empty">
          <p>This workspace is not a git repository.</p>
          <button
            className="git-btn git-btn-primary"
            onClick={async () => { try { await api.gitInit(); await refresh(); } catch (e) { setError((e as Error).message); } }}
          >
            Initialize Repository
          </button>
        </div>
      </div>
    );
  }

  const branchLabel = status?.detached ? `(detached) ${status.branch}` : status?.branch || "—";
  const canCommit = (staged.length > 0 || (unstaged.length + untracked.length > 0)) && message.trim().length > 0 && !committing;
  const stageAll = staged.length === 0 && (unstaged.length + untracked.length > 0);

  return (
    <div className={`git-panel${working ? " git-working" : ""}`}>
      <div className="git-header">
        <div className="git-section-title">
          <span>SOURCE CONTROL</span>
          {totalChanges > 0 ? <span className="git-badge">{totalChanges}</span> : null}
          {working && <span className="git-spinner" title="Working…" />}
        </div>
        <div className="git-header-actions">
          <button title="Stage all changes" onClick={() => stage([...unstaged.map((f) => f.path), ...untracked.map((f) => f.path)])} disabled={working || unstaged.length + untracked.length === 0}>＋</button>
          <button title="Refresh" onClick={() => void refresh()} disabled={loading || working}><IconRefreshCw size={13} /></button>
        </div>
      </div>

      <div className="git-commit-box">
        <textarea
          className="git-commit-msg"
          placeholder={`Message (${navigator.platform.startsWith("Mac") ? "⌘" : "Ctrl"}+Enter to commit on "${branchLabel}")`}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={onMessageKey}
          rows={2}
        />
        <button
          className="git-btn git-btn-primary git-commit-btn"
          onClick={() => void doCommit({ stageAll })}
          disabled={!canCommit}
          title={stageAll ? "Stage all & commit" : "Commit staged changes"}
        >
          <IconCheck size={13} style={{ marginRight: 4 }} />Commit{stageAll ? " All" : ""}
        </button>
      </div>

      {error ? <div className="git-error" onClick={() => setError(null)}>{error}</div> : null}

      <div className="git-branch-row" title={status?.upstream ? `Tracking ${status.upstream}` : "No upstream"}>
        <span className="git-branch-icon" aria-hidden>
          {/* Branch glyph */}
          <svg viewBox="0 0 16 16" width="12" height="12">
            <path
              d="M11.75 2.5a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 0 0 0-3.5zM4.25 13.5a1.75 1.75 0 1 0 0-3.5 1.75 1.75 0 0 0 0 3.5zM4.25 2.5a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 0 0 0-3.5z"
              fill="currentColor"
            />
            <path d="M4.25 6v4M11.75 6v.75A3.75 3.75 0 0 1 8 10.5H4.25" stroke="currentColor" strokeWidth="1.5" fill="none" />
          </svg>
        </span>
        <span className="git-branch-name">{branchLabel}</span>
        {status?.upstream ? (
          <span className="git-branch-upstream">{status.upstream}</span>
        ) : null}
        {status?.ahead || status?.behind ? (
          <span className="git-ahead-behind">
            {status.behind ? <span title={`${status.behind} commits behind`}>↓{status.behind}</span> : null}
            {status.ahead ? <span title={`${status.ahead} commits ahead`}>↑{status.ahead}</span> : null}
          </span>
        ) : null}
      </div>

      <FileSection
        title="Staged Changes"
        count={staged.length}
        files={staged}
        emptyHint={null}
        onClick={viewDiff}
        rowActions={(f) => (
          <>
            <RowBtn title="Unstage" onClick={() => unstage([f.path])}>−</RowBtn>
          </>
        )}
        bulkActions={
          staged.length > 0 ? (
            <RowBtn title="Unstage all" onClick={() => unstage(staged.map((f) => f.path))}>−</RowBtn>
          ) : null
        }
      />

      <FileSection
        title="Changes"
        count={unstaged.length}
        files={unstaged}
        emptyHint={null}
        onClick={viewDiff}
        rowActions={(f) => (
          <>
            <RowBtn title="Discard changes" onClick={() => discard([f.path])}><IconRotateCcw size={12} /></RowBtn>
            <RowBtn title="Stage changes" onClick={() => stage([f.path])}>＋</RowBtn>
          </>
        )}
        bulkActions={
          unstaged.length > 0 ? (
            <>
              <RowBtn title="Discard all" onClick={() => discard(unstaged.map((f) => f.path))}><IconRotateCcw size={12} /></RowBtn>
              <RowBtn title="Stage all" onClick={() => stage(unstaged.map((f) => f.path))}>＋</RowBtn>
            </>
          ) : null
        }
      />

      {untracked.length > 0 ? (
        <FileSection
          title="Untracked"
          count={untracked.length}
          files={untracked}
          emptyHint={null}
          onClick={viewDiff}
          rowActions={(f) => (
            <>
              <RowBtn title="Stage" onClick={() => stage([f.path])}>＋</RowBtn>
            </>
          )}
          bulkActions={
            <RowBtn title="Stage all untracked" onClick={() => stage(untracked.map((f) => f.path))}>＋</RowBtn>
          }
        />
      ) : null}

      {totalChanges === 0 ? (
        <div className="git-clean">No changes — working tree clean.</div>
      ) : null}

      <div className="git-section">
        <div className="git-section-header">
          <span className="git-section-name">GRAPH</span>
          {log.length ? <span className="git-section-count">{showAll ? log.length : Math.min(log.length, 8)}</span> : null}
        </div>
        {log.length === 0 ? (
          <div className="git-empty-row">No commits yet.</div>
        ) : (
          <ul className="git-log">
            {(showAll ? log : log.slice(0, 8)).map((c, i, arr) => (
              <li key={c.hash} className={`git-log-row${i === 0 ? " git-log-head" : ""}`} title={`${c.hash}\n${c.author} <${c.email}>\n${c.date}`}>
                <span className="git-log-graph" aria-hidden>
                  <span className={`git-log-dot${i === 0 ? " git-log-dot-head" : ""}`} />
                  {i < arr.length - 1 ? <span className="git-log-line" /> : null}
                </span>
                <span className="git-log-meta">
                  <span className="git-log-subject">{c.subject || "(no subject)"}</span>
                  <span className="git-log-sub">
                    <span className="git-log-hash">{c.abbrev}</span>
                    <span className="git-log-author">{c.author}</span>
                    <span className="git-log-date">{relativeTime(c.ts)}</span>
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
        {log.length > 8 ? (
          <button className="git-show-more" onClick={() => setShowAll((v) => !v)}>
            {showAll ? "Show less" : `Show ${log.length - 8} more`}
          </button>
        ) : null}
      </div>
    </div>
  );
}

// ───────────────── Sub-components ─────────────────

interface FileSectionProps {
  title: string;
  count: number;
  files: GitFileEntry[];
  emptyHint: React.ReactNode;
  onClick: (f: GitFileEntry) => void;
  rowActions?: (f: GitFileEntry) => React.ReactNode;
  bulkActions?: React.ReactNode;
}

function FileSection({ title, count, files, emptyHint, onClick, rowActions, bulkActions }: FileSectionProps) {
  const [open, setOpen] = useState(true);
  if (count === 0 && !emptyHint) return null;
  return (
    <div className={`git-section ${open ? "git-section--open" : ""}`}>
      <div className="git-section-header" onClick={() => setOpen((v) => !v)}>
        <ChevronExpand expanded={open} className="git-section-caret" size={13} />
        <span className="git-section-name">{title}</span>
        {count > 0 ? <span className="git-section-count">{count}</span> : null}
        <span className="git-section-spacer" />
        {open && bulkActions ? <span className="git-section-actions" onClick={(e) => e.stopPropagation()}>{bulkActions}</span> : null}
      </div>
      <div className="git-section-body-shell" aria-hidden={!open}>
        <div className="git-section-body-inner">
          {files.length === 0 ? (
            <div className="git-empty-row">{emptyHint}</div>
          ) : (
            <ul className="git-files">
              {files.map((f) => (
                <FileRow key={f.path} file={f} onClick={onClick} actions={rowActions} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

interface FileRowProps {
  file: GitFileEntry;
  onClick: (f: GitFileEntry) => void;
  actions?: (f: GitFileEntry) => React.ReactNode;
}

function FileRow({ file, onClick, actions }: FileRowProps) {
  // Status letter: prefer the staged/index column if non-space, else worktree.
  const letter = file.untracked ? "U" : (file.indexStatus !== " " ? file.indexStatus : file.workStatus);
  const color = STATUS_COLORS[letter] || "#9d9d9d";
  const tooltip = `${STATUS_LABELS[letter] || file.code} · ${file.path}`;
  const lastSlash = file.path.lastIndexOf("/");
  const name = lastSlash >= 0 ? file.path.slice(lastSlash + 1) : file.path;
  const dir = lastSlash >= 0 ? file.path.slice(0, lastSlash) : "";
  return (
    <li className="git-file-row" title={tooltip}>
      <button className="git-file-main" onClick={() => onClick(file)}>
        <FileIcon name={name} size={14} />
        <span className="git-file-name">{name}</span>
        {dir ? <span className="git-file-dir">{dir}</span> : null}
      </button>
      <span className="git-file-actions" onClick={(e) => e.stopPropagation()}>
        {actions ? actions(file) : null}
      </span>
      <span className="git-file-status" style={{ color }} aria-label={STATUS_LABELS[letter] || letter}>
        {letter}
      </span>
    </li>
  );
}

function RowBtn({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button className="git-row-btn" title={title} onClick={(e) => { e.stopPropagation(); onClick(); }}>
      {children}
    </button>
  );
}

// ───────────────── Helpers ─────────────────

function relativeTime(ts: number): string {
  if (!ts) return "";
  const diff = Date.now() / 1000 - ts;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d`;
  if (diff < 86400 * 365) return `${Math.floor(diff / 86400 / 30)}mo`;
  return `${Math.floor(diff / 86400 / 365)}y`;
}
