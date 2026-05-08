import { useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import { api } from "../lib/api";
import { revertTargetFileMissing } from "../lib/diffErrors";
import { useDialogs } from "./DialogProvider";
import { ChevronExpand } from "./ChevronExpand";
import { FileIcon } from "./FileIcon";
import { IconX, IconCheck } from "./Icons";

export interface DiffItem {
  id: string;
  diff: string;
  reverted?: boolean;
}

interface Props {
  diffs: DiffItem[];
  onClear: () => void;
  onUpdate: (id: string, patch: Partial<DiffItem>) => void;
  /** Open the file directly in the regular editor. */
  onOpen: (path: string) => void;
  /** Open the unified diff in a side-by-side DIFF view. */
  onOpenDiff?: (item: DiffItem, path: string) => void;
  /** Drop a single diff from the review list (used by the per-row "✓ Keep"). */
  onRemove?: (id: string) => void;
  hideHeader?: boolean;
}

interface Stats { adds: number; dels: number; }

function parseDiff(diff: string): { path: string; stats: Stats } {
  const m = /^\+\+\+\s+b\/(.+)$/m.exec(diff);
  const path = m?.[1] ?? "";
  let adds = 0; let dels = 0;
  for (const ln of diff.split("\n")) {
    if (ln.startsWith("+++") || ln.startsWith("---")) continue;
    if (ln.startsWith("+")) adds++;
    else if (ln.startsWith("-")) dels++;
  }
  return { path, stats: { adds, dels } };
}

function DiffRow({
  item, onUpdate, onOpen, onOpenDiff, onRemove,
}: {
  item: DiffItem;
  onUpdate: (p: Partial<DiffItem>) => void;
  onOpen: (path: string) => void;
  onOpenDiff?: (item: DiffItem, path: string) => void;
  onRemove?: () => void;
}) {
  const dlg = useDialogs();
  const { path, stats } = useMemo(() => parseDiff(item.diff), [item.diff]);

  function clickFile() {
    if (!path) return;
    if (onOpenDiff) onOpenDiff(item, path);
    else onOpen(path);
  }

  async function reject(e: ReactMouseEvent) {
    e.stopPropagation();
    if (item.reverted) return;
    try {
      await api.revertDiff(item.diff);
      if (onRemove) onRemove();
      else onUpdate({ reverted: true });
    } catch (err) {
      if (revertTargetFileMissing(err)) {
        if (onRemove) onRemove();
        else onUpdate({ reverted: true });
        return;
      }
      void dlg.alert((err as Error).message);
    }
  }
  function accept(e: ReactMouseEvent) {
    e.stopPropagation();
    if (item.reverted) return;
    onRemove?.();
  }

  return (
    <button
      type="button"
      className={`diff-row ${item.reverted ? "reverted" : ""}`}
      onClick={clickFile}
      title={onOpenDiff ? `Review changes in ${path}` : `Open ${path}`}
    >
      <span className="file-icon" aria-hidden>
        <FileIcon name={path.split("/").pop() || ""} size={14} />
      </span>
      <span className="file-name">{path.split("/").pop() || "(unknown)"}</span>
      <span className="diff-stats">
        {stats.adds > 0 && <span className="add">+{stats.adds}</span>}
        {stats.dels > 0 && <span className="del">−{stats.dels}</span>}
      </span>
      {item.reverted && <span className="reverted-tag">undone</span>}
      {/* Per-row actions — hover-revealed pill buttons that mirror the global
          "Undo All / Keep All" controls but scoped to this single file.
          Reject reverts the file on disk, Accept silently drops it from the review
          list (file already on disk → "I'm happy with it"). */}
      {!item.reverted && (
        <span className="row-actions" onClick={(e) => e.stopPropagation()}>
          <span
            role="button"
            tabIndex={0}
            className="row-act row-reject"
            title="Reject — undo this file's changes on disk"
            onClick={reject}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") void reject(e as unknown as ReactMouseEvent); }}
          ><IconX size={12} /></span>
          {onRemove && (
            <span
              role="button"
              tabIndex={0}
              className="row-act row-accept"
              title="Accept — keep these changes and dismiss from this list"
              onClick={accept}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") accept(e as unknown as ReactMouseEvent); }}
              ><IconCheck size={12} /></span>
          )}
        </span>
      )}
    </button>
  );
}

export function DiffViewer({ diffs, onClear, onUpdate, onOpen, onOpenDiff, onRemove, hideHeader }: Props) {
  /** With no header there is no toggle — keep the file list expanded (not collapsed). */
  const [collapsed, setCollapsed] = useState(false);
  const [busyAll, setBusyAll] = useState<null | "undo" | "keep">(null);

  if (diffs.length === 0) {
    return <div className="diff-viewer diff-empty">No changes yet. Run the agent to see diffs here.</div>;
  }

  const active = diffs.filter((d) => !d.reverted);
  const activeCount = active.length;

  async function undoAll() {
    if (busyAll) return;
    setBusyAll("undo");
    try {
      for (const d of active) {
        try {
          await api.revertDiff(d.diff);
          if (onRemove) onRemove(d.id);
          else onUpdate(d.id, { reverted: true });
        } catch (err) {
          if (revertTargetFileMissing(err)) {
            if (onRemove) onRemove(d.id);
            else onUpdate(d.id, { reverted: true });
          }
        }
      }
    } finally {
      setBusyAll(null);
    }
  }

  function keepAll() {
    if (busyAll) return;
    setBusyAll("keep");
    try { onClear(); } finally { setBusyAll(null); }
  }

  function reviewAll() {
    for (const item of active) {
      const { path } = parseDiff(item.diff);
      if (!path) continue;
      if (onOpenDiff) onOpenDiff(item, path);
      else onOpen(path);
    }
  }

  return (
    <div className={`diff-viewer ${collapsed ? "" : "diff-viewer--expanded"}`}>
      {!hideHeader && (
        <div className="diff-viewer-head">
          <button
            className="changes-toggle"
            onClick={() => setCollapsed((v) => !v)}
            title={collapsed ? "Expand list" : "Collapse list"}
          >
            <ChevronExpand expanded={!collapsed} className="chev" />
            <span className="count">{activeCount} {activeCount === 1 ? "File" : "Files"}</span>
          </button>
          <span className="spacer" />
          <button
            className="head-btn"
            onClick={undoAll}
            disabled={!activeCount || busyAll !== null}
            title="Revert every pending change on disk"
          >Undo All</button>
          <button
            className="head-btn"
            onClick={keepAll}
            disabled={!activeCount || busyAll !== null}
            title="Accept all changes — clear from this list (files stay as-is)"
          >Keep All</button>
          <button
            className="head-btn primary"
            onClick={reviewAll}
            disabled={!activeCount}
            title="Open all pending changes for review"
          >Review</button>
        </div>
      )}
      <div className="diff-rows-shell" aria-hidden={collapsed}>
        <div className="diff-rows-inner">
          <div className="diff-rows">
            {diffs.map((it) => (
              <DiffRow
                key={it.id}
                item={it}
                onUpdate={(p) => onUpdate(it.id, p)}
                onOpen={onOpen}
                onOpenDiff={onOpenDiff}
                onRemove={onRemove ? () => onRemove(it.id) : undefined}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
