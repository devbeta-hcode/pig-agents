import { DiffEditor as MonacoDiffEditor } from "@monaco-editor/react";
import type { editor as MonacoEditorNS } from "monaco-editor";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { IconX, IconRotateCcw } from "./Icons";

/**
 * `gitContext` tells the diff view which per-hunk actions to show:
 *   "unstaged" — Stage (+) / Discard (↶)   (worktree vs index)
 *   "staged"   — Unstage (↩)               (index vs HEAD)
 *   null/undef — no per-hunk git actions   (agent-generated diff, etc.)
 */
export type GitDiffContext = "unstaged" | "staged" | null | undefined;
export type HunkAction = "stage" | "discard" | "unstage";

interface Props {
  path: string;
  diff: string;
  reverted?: boolean;
  onClose: () => void;
  onOpenFile: (path: string) => void;
  onRevert?: () => void;
  onAccept?: () => void;
  /** When set, enables per-hunk Stage / Discard / Unstage widgets. */
  gitContext?: GitDiffContext;
  /** Called when the user clicks a per-hunk action. Caller should apply the
   *  patch (via `api.gitApply`) and refresh the diff. */
  onHunkAction?: (mode: HunkAction, patch: string) => void | Promise<void>;
}

const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  json: "json", md: "markdown", py: "python", go: "go", rs: "rust",
  html: "html", css: "css", scss: "scss", yaml: "yaml", yml: "yaml",
  sh: "shell", bash: "shell", java: "java", c: "c", cpp: "cpp",
  rb: "ruby", php: "php", sql: "sql", toml: "ini",
};
function langFor(p: string): string {
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  return LANG_BY_EXT[ext] ?? "plaintext";
}

interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  body: string[];
  /** Raw header line as seen in the source diff. */
  header: string;
}

function parseHunks(diff: string): Hunk[] {
  const out: Hunk[] = [];
  const lines = diff.split("\n");
  let i = 0;
  while (i < lines.length) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i]);
    if (!m) { i++; continue; }
    const h: Hunk = {
      oldStart: parseInt(m[1], 10),
      oldLines: m[2] ? parseInt(m[2], 10) : 1,
      newStart: parseInt(m[3], 10),
      newLines: m[4] ? parseInt(m[4], 10) : 1,
      body: [],
      header: lines[i],
    };
    i++;
    while (i < lines.length && !lines[i].startsWith("@@")
        && !lines[i].startsWith("--- ") && !lines[i].startsWith("+++ ")
        && !lines[i].startsWith("diff ")) {
      h.body.push(lines[i]);
      i++;
    }
    out.push(h);
  }
  return out;
}

/**
 * Build a self-contained unified patch that targets ONE hunk so `git apply`
 * can stage/discard/unstage exactly that piece. Uses POSIX path separators
 * because `git apply` always expects them in the patch body.
 */
function buildSingleHunkPatch(path: string, hunk: Hunk): string {
  const p = path.replace(/\\/g, "/");
  // Rebuild the hunk header canonically so it always has counts even when
  // the source diff used the short " @@" form.
  const hdr = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
  const body = hunk.body.join("\n");
  return `--- a/${p}\n+++ b/${p}\n${hdr}\n${body}\n`;
}

/**
 * Reconstruct the "before" version of a file by reverse-applying a unified
 * diff onto the current "after" content.
 */
function reverseApply(modifiedFull: string, diff: string): string {
  const hunks = parseHunks(diff);
  if (hunks.length === 0) {
    return reconstructOriginalFromBody(diff);
  }
  const result = modifiedFull.split("\n");
  for (const h of [...hunks].reverse()) {
    const origLines: string[] = [];
    for (const ln of h.body) {
      if (!ln.length) continue;
      if (ln.startsWith("\\")) continue;
      const marker = ln[0];
      const text = ln.slice(1);
      if (marker === "+") continue;
      if (marker === "-" || marker === " ") origLines.push(text);
      else origLines.push(ln);
    }
    const start = Math.max(0, h.newStart - 1);
    result.splice(start, h.newLines, ...origLines);
  }
  return result.join("\n");
}

function reconstructOriginalFromBody(diff: string): string {
  const lines = diff.split("\n");
  let inBody = false;
  const out: string[] = [];
  for (const ln of lines) {
    if (ln.startsWith("@@")) { inBody = true; continue; }
    if (!inBody) continue;
    if (ln.startsWith("+++") || ln.startsWith("---") || ln.startsWith("diff ")) continue;
    if (ln.startsWith("\\")) continue;
    if (ln.length === 0) continue;
    const marker = ln[0];
    if (marker === "+") continue;
    if (marker === "-" || marker === " ") out.push(ln.slice(1));
    else out.push(ln);
  }
  return out.join("\n");
}

function snippetsFromDiff(diff: string): { original: string; modified: string } {
  const o: string[] = []; const m: string[] = [];
  for (const ln of diff.split("\n")) {
    if (ln.startsWith("+++") || ln.startsWith("---") || ln.startsWith("diff ")
        || ln.startsWith("@@") || ln.startsWith("\\")) continue;
    if (ln.startsWith("+")) m.push(ln.slice(1));
    else if (ln.startsWith("-")) o.push(ln.slice(1));
    else if (ln.startsWith(" ")) { o.push(ln.slice(1)); m.push(ln.slice(1)); }
  }
  return { original: o.join("\n"), modified: m.join("\n") };
}

/**
 * True when the unified diff was generated against an absent original
 * (i.e. the patch CREATED the file). The backend marks these with a
 * `# ba:created-from-absent` line in the diff body, and `git`-style new
 * files use `--- /dev/null`. In both cases there's nothing to read off
 * disk for the "before" side, and a missing-file ENOENT is expected (and
 * not actually an error) — we should just render the diff snippet without
 * the scary "File can't be read" banner.
 */
function isCreatedFromAbsentDiff(diff: string): boolean {
  if (!diff) return false;
  if (diff.includes("# ba:created-from-absent")) return true;
  if (/^---\s+\/dev\/null/m.test(diff)) return true;
  return false;
}

type MonacoNS = typeof import("monaco-editor");

export function DiffEditorView({
  path, diff, reverted, onClose, onOpenFile, onRevert,
  gitContext, onHunkAction,
}: Props) {
  const [modified, setModified] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyHunk, setBusyHunk] = useState<number | null>(null);

  const editorRef = useRef<MonacoEditorNS.IStandaloneDiffEditor | null>(null);
  const monacoRef = useRef<MonacoNS | null>(null);
  const [editorReady, setEditorReady] = useState(false);
  /** View-zone ids we've attached so we can tear them down before re-adding. */
  const zoneIdsRef = useRef<string[]>([]);
  /** Hold the latest onHunkAction so we don't re-attach on every render. */
  const onHunkActionRef = useRef<Props["onHunkAction"]>(undefined);
  onHunkActionRef.current = onHunkAction;

  useEffect(() => {
    let cancelled = false;
    setError(null); setModified(null);
    // For "created from absent" diffs the file may legitimately not exist
    // yet (or got reverted). Skip the read so we don't surface a misleading
    // ENOENT — the modified content is fully reconstructible from the diff
    // body, and the original side is just empty.
    if (isCreatedFromAbsentDiff(diff)) {
      const s = snippetsFromDiff(diff);
      setModified(s.modified);
      return () => { cancelled = true; };
    }
    api.readFile(path)
      .then((r) => { if (!cancelled) setModified(r.content); })
      .catch((e) => {
        if (cancelled) return;
        // Treat ENOENT as a soft fallback: render whatever we can from the
        // diff body instead of blocking with an error banner. This happens
        // when the diff references a path outside the active workspace
        // (e.g. an old chat session whose workspace differed) or after a
        // file was deleted.
        const msg = (e as Error).message || String(e);
        if (/ENOENT|no such file/i.test(msg)) {
          const s = snippetsFromDiff(diff);
          setModified(s.modified || "");
        } else {
          setError(msg);
        }
      });
    return () => { cancelled = true; };
  }, [path, diff]);

  const hunks = useMemo(() => parseHunks(diff), [diff]);

  const { original, modifiedText } = useMemo(() => {
    // New-file diffs: there's no "before" to show; left side stays empty
    // and the right side is the modified text we already have (either from
    // disk or reconstructed from the diff body in the read effect above).
    if (isCreatedFromAbsentDiff(diff)) {
      return { original: "", modifiedText: modified ?? snippetsFromDiff(diff).modified };
    }
    if (modified !== null) {
      return { original: reverseApply(modified, diff), modifiedText: modified };
    }
    if (error) {
      const s = snippetsFromDiff(diff);
      return { original: s.original, modifiedText: s.modified };
    }
    return { original: "", modifiedText: "" };
  }, [modified, diff, error]);

  const stats = useMemo(() => {
    let adds = 0; let dels = 0;
    for (const ln of diff.split("\n")) {
      if (ln.startsWith("+++") || ln.startsWith("---")) continue;
      if (ln.startsWith("+")) adds++;
      else if (ln.startsWith("-")) dels++;
    }
    return { adds, dels };
  }, [diff]);

  const runHunk = useCallback(
    async (mode: HunkAction, hunkIdx: number) => {
      const handler = onHunkActionRef.current;
      if (!handler) return;
      const h = hunks[hunkIdx];
      if (!h) return;
      setBusyHunk(hunkIdx);
      try {
        await handler(mode, buildSingleHunkPatch(path, h));
      } finally {
        setBusyHunk(null);
      }
    },
    [hunks, path],
  );

  /** Remove any previously-installed hunk view zones. */
  const clearWidgets = useCallback(() => {
    const ed = editorRef.current?.getModifiedEditor();
    if (!ed) return;
    ed.changeViewZones((accessor: MonacoEditorNS.IViewZoneChangeAccessor) => {
      for (const id of zoneIdsRef.current) accessor.removeZone(id);
    });
    zoneIdsRef.current = [];
  }, []);

  /** Attach a Stage/Discard (or Unstage) toolbar above each hunk. */
  const attachWidgets = useCallback(() => {
    const ed = editorRef.current?.getModifiedEditor();
    const monaco = monacoRef.current;
    if (!ed || !monaco) return;
    clearWidgets();
    if (!gitContext || !onHunkActionRef.current || hunks.length === 0) return;

    ed.changeViewZones((accessor: MonacoEditorNS.IViewZoneChangeAccessor) => {
      hunks.forEach((h, i) => {
        const node = document.createElement("div");
        node.className = "bha-git-widget bha-git-zone";

        const mkBtn = (
          mode: HunkAction,
          label: string,
          icon: string,
          title: string,
          kind: "primary" | "warn" | "neutral",
        ) => {
          const b = document.createElement("button");
          b.type = "button";
          b.className = `bha-btn bha-${kind}`;
          b.title = title;
          b.innerHTML = `<span class="bha-icon">${icon}</span><span>${label}</span>`;
          b.onclick = (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            void runHunk(mode, i);
          };
          if (busyHunk === i) b.setAttribute("disabled", "true");
          return b;
        };

        const label = document.createElement("span");
        label.className = "bha-hunk-label";
        label.textContent = `Hunk ${i + 1}/${hunks.length}`;
        node.appendChild(label);

        if (gitContext === "unstaged") {
          node.appendChild(mkBtn("stage", "Stage", `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m20 6-11 11-5-5"/></svg>`, "Stage just this hunk", "primary"));
          node.appendChild(mkBtn("discard", "Discard", `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>`, "Discard just this hunk on disk", "warn"));
        } else if (gitContext === "staged") {
          node.appendChild(mkBtn("unstage", "Unstage", `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 9"/><path d="M21 3v6h-6"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 15"/><path d="M3 21v-6h6"/></svg>`, "Unstage just this hunk", "neutral"));
        }

        // Zone sits ABOVE the first line of the hunk. `afterLineNumber: 0`
        // places the zone above line 1.
        const afterLine = Math.max(0, h.newStart - 1);
        const id = accessor.addZone({
          afterLineNumber: afterLine,
          heightInPx: 26,
          domNode: node,
          suppressMouseDown: false,
        });
        zoneIdsRef.current.push(id);
      });
    });
  }, [hunks, gitContext, runHunk, clearWidgets, busyHunk]);

  useEffect(() => {
    if (modified === null || !editorReady) return;
    attachWidgets();
    return clearWidgets;
  }, [modified, editorReady, attachWidgets, clearWidgets]);

  const handleMount = useCallback(
    (editor: MonacoEditorNS.IStandaloneDiffEditor, monaco: MonacoNS) => {
      editorRef.current = editor;
      monacoRef.current = monaco;
      setEditorReady(true);
    },
    [],
  );

  return (
    <div className="diff-editor-view">
      <div className="diff-editor-head">
        <span className="diff-editor-tag">DIFF</span>
        <span className="diff-editor-path" title={path}>{path}</span>
        <span className="diff-editor-stats">
          {stats.adds > 0 && <span className="add">+{stats.adds}</span>}
          {stats.dels > 0 && <span className="del">−{stats.dels}</span>}
        </span>
        {reverted && <span className="diff-editor-reverted">reverted</span>}
        {gitContext && (
          <span className={`diff-editor-ctx ctx-${gitContext}`}>
            {gitContext === "staged" ? "STAGED" : "UNSTAGED"}
          </span>
        )}
        <span className="spacer" />
        <button
          className="dev-btn"
          onClick={() => onOpenFile(path)}
          title="Open this file for editing"
        >✎ Edit file</button>
        {onRevert && !reverted && (
          <button className="dev-btn warn" onClick={onRevert} title="Revert this patch on disk">
            <IconRotateCcw size={12} style={{ marginRight: 4 }} />Revert
          </button>
        )}
        <button className="dev-btn" onClick={onClose} title="Close diff view"><IconX size={13} /></button>
      </div>
      <div className="diff-editor-body">
        {modified === null && !error && (
          <div className="editor-empty">Loading diff…</div>
        )}
        {modified !== null && (
          <MonacoDiffEditor
            height="100%"
            theme="vs-dark"
            language={langFor(path)}
            original={original}
            modified={modifiedText}
            onMount={handleMount}
            options={{
              renderSideBySide: true,
              readOnly: true,
              fontSize: 13,
              minimap: { enabled: false },
              automaticLayout: true,
              scrollBeyondLastLine: false,
              renderOverviewRuler: false,
              originalEditable: false,
            }}
          />
        )}
        {modified === null && error && (
          <div className="diff-editor-fallback">
            <div className="diff-editor-fallback-msg">
              File can't be read on disk ({error}). Showing diff snippet only.
            </div>
            <MonacoDiffEditor
              height="100%"
              theme="vs-dark"
              language={langFor(path)}
              original={original}
              modified={modifiedText}
              options={{
                renderSideBySide: true,
                readOnly: true,
                fontSize: 13,
                minimap: { enabled: false },
                automaticLayout: true,
                scrollBeyondLastLine: false,
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
