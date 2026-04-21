import Editor, { type OnMount } from "@monaco-editor/react";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { api } from "../lib/api";

interface Props {
  path: string;
  gotoLine?: number;
  onSaved?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  /** Unified diff text for this file's pending change. When set, the editor
   *  decorates added lines with green and renders removed lines as inline
   *  red view zones so the user can spot exactly what changed. */
  pendingDiff?: string | null;
  /** Identifier of the diff item the pendingDiff belongs to. Required for
   *  per-hunk Keep/Undo widgets — they emit `ba:hunk-action` events with
   *  this id so App.tsx can mutate the right DiffItem. */
  pendingDiffId?: string | null;
  /** Bump to force a re-read from disk (e.g. after a revert). */
  reloadKey?: number;
}

interface ParsedHunk {
  /** 0-based index matching backend hunk ordering. */
  index: number;
  addedLines: number[];
  // Removed lines, grouped by where they should appear in the modified file.
  // afterLine = 0 means "before line 1".
  removedBlocks: { afterLine: number; lines: string[] }[];
  /** Line in the MODIFIED file the per-hunk action widget should anchor to. */
  anchorLine: number;
}

function parsePendingDiff(diff: string): ParsedHunk[] {
  const hunks: ParsedHunk[] = [];
  let cur: ParsedHunk | null = null;
  let hunkCounter = 0;
  let modLine = 1;
  let pendingDel: string[] = [];
  let pendingDelAnchor = 0;

  function flushDel() {
    if (!cur || pendingDel.length === 0) return;
    cur.removedBlocks.push({ afterLine: pendingDelAnchor, lines: pendingDel });
    pendingDel = [];
  }

  function pushCur() {
    if (!cur) return;
    flushDel();
    if (cur.addedLines.length > 0 || cur.removedBlocks.length > 0) hunks.push(cur);
    cur = null;
  }

  for (const ln of diff.split("\n")) {
    if (ln.startsWith("@@")) {
      pushCur();
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(ln);
      const newStart = m ? parseInt(m[2], 10) : 1;
      // Always advance the hunk counter so the index aligns 1:1 with the
      // backend, even for empty/no-op hunks we drop client-side.
      cur = { index: hunkCounter++, addedLines: [], removedBlocks: [], anchorLine: Math.max(1, newStart) };
      modLine = Math.max(1, newStart);
      continue;
    }
    if (!cur) continue;
    if (ln.startsWith("\\") || ln.length === 0) continue;
    const marker = ln[0];
    const text = ln.slice(1);
    if (marker === "+") {
      cur.addedLines.push(modLine);
      modLine++;
    } else if (marker === " ") {
      flushDel();
      modLine++;
    } else if (marker === "-") {
      // anchor at the previous modified line (0 if at the very top)
      if (pendingDel.length === 0) pendingDelAnchor = modLine - 1;
      pendingDel.push(text);
    }
  }
  pushCur();

  // Pick anchor: first added line, else the line just below the first removed block,
  // else fall back to the hunk's newStart already set above.
  for (const h of hunks) {
    if (h.addedLines.length > 0) h.anchorLine = h.addedLines[0];
    else if (h.removedBlocks.length > 0) h.anchorLine = Math.max(1, h.removedBlocks[0].afterLine + 1);
  }
  return hunks;
}

export interface FileEditorHandle {
  save: () => Promise<void>;
  insertAtCursor: (text: string) => void;
  replaceAll: (text: string) => void;
  getPath: () => string;
}

const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  json: "json", md: "markdown", py: "python", go: "go", rs: "rust",
  html: "html", css: "css", scss: "scss", yaml: "yaml", yml: "yaml",
  sh: "shell", bash: "shell", java: "java", c: "c", cpp: "cpp", h: "c", hpp: "cpp",
  rb: "ruby", php: "php", sql: "sql", toml: "ini",
};

function langFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return LANG_BY_EXT[ext] ?? "plaintext";
}

export const FileEditor = forwardRef<FileEditorHandle, Props>(function FileEditor(
  { path, gotoLine, onSaved, onDirtyChange, pendingDiff, pendingDiffId, reloadKey },
  ref,
) {
  const [content, setContent] = useState<string>("");
  const [original, setOriginal] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);
  const decorationsRef = useRef<string[]>([]);
  const viewZoneIdsRef = useRef<string[]>([]);
  const hunkWidgetsRef = useRef<any[]>([]);
  // Always read latest content/original from refs inside `save()` so an
  // imperative call from a parent toolbar never persists a stale snapshot.
  const contentRef = useRef(content);
  const originalRef = useRef(original);
  useEffect(() => { contentRef.current = content; }, [content]);
  useEffect(() => { originalRef.current = original; }, [original]);
  // Stash callbacks in refs so effects don't re-fire when parent re-renders
  // (prevents "Maximum update depth exceeded" when parent passes inline lambdas).
  const onDirtyChangeRef = useRef(onDirtyChange);
  const onSavedRef = useRef(onSaved);
  useEffect(() => { onDirtyChangeRef.current = onDirtyChange; }, [onDirtyChange]);
  useEffect(() => { onSavedRef.current = onSaved; }, [onSaved]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api.readFile(path)
      .then((r) => { if (!cancelled) { setContent(r.content); setOriginal(r.content); } })
      .catch((err) => { if (!cancelled) setError((err as Error).message); });
    return () => { cancelled = true; };
  }, [path, reloadKey]);

  useEffect(() => {
    onDirtyChangeRef.current?.(content !== original);
  }, [content, original]);

  useEffect(() => {
    if (gotoLine && editorRef.current) {
      const ed = editorRef.current;
      ed.revealLineInCenter(gotoLine);
      ed.setPosition({ lineNumber: gotoLine, column: 1 });
      ed.focus();
    }
  }, [gotoLine]);

  async function save() {
    if (contentRef.current === originalRef.current) return;
    try {
      const snapshot = contentRef.current;
      await api.writeFile(path, snapshot);
      setOriginal(snapshot);
      onSavedRef.current?.();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function insertAtCursor(text: string) {
    const ed = editorRef.current;
    if (!ed) {
      setContent((c) => c + (c.endsWith("\n") || !c ? "" : "\n") + text);
      return;
    }
    const sel = ed.getSelection();
    if (sel) {
      ed.executeEdits("ba-insert", [{ range: sel, text, forceMoveMarkers: true }]);
      ed.focus();
    }
  }

  function replaceAll(text: string) {
    const ed = editorRef.current;
    if (!ed) {
      setContent(text);
      return;
    }
    const model = ed.getModel();
    if (!model) { setContent(text); return; }
    const fullRange = model.getFullModelRange();
    ed.executeEdits("ba-replace-all", [{ range: fullRange, text, forceMoveMarkers: true }]);
    ed.focus();
  }

  useImperativeHandle(
    ref,
    () => ({ save, insertAtCursor, replaceAll, getPath: () => path }),
    [path],
  );

  const onMount: OnMount = (ed, monaco) => {
    editorRef.current = ed;
    monacoRef.current = monaco;
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { void save(); });
    if (gotoLine) {
      ed.revealLineInCenter(gotoLine);
      ed.setPosition({ lineNumber: gotoLine, column: 1 });
    }

    // ---- Cursor-style selection popup (Add to Chat / Quick Edit) ----------
    function emitSelection(kind: "add-to-chat" | "quick-edit") {
      const sel = ed.getSelection();
      if (!sel || sel.isEmpty()) return;
      const model = ed.getModel();
      if (!model) return;
      const text = model.getValueInRange(sel);
      window.dispatchEvent(new CustomEvent(`ba:${kind}`, {
        detail: {
          path,
          startLine: sel.startLineNumber,
          endLine: sel.endLineNumber,
          text,
          language: langFor(path),
        },
      }));
    }

    const popupNode = document.createElement("div");
    popupNode.className = "ba-selection-popup";
    popupNode.innerHTML = `
      <button type="button" class="bsp-btn bsp-add" title="Add this snippet to chat (Ctrl/Cmd+L)">
        <span class="bsp-kbd">⌘L</span><span>Add to Chat</span>
      </button>
      <button type="button" class="bsp-btn bsp-edit" title="Edit this selection with the agent (Ctrl/Cmd+K)">
        <span class="bsp-kbd">⌘K</span><span>Quick Edit</span>
      </button>
    `;
    // mousedown would otherwise blur the editor / clear the selection.
    popupNode.addEventListener("mousedown", (e) => e.preventDefault());
    popupNode.querySelector(".bsp-add")?.addEventListener("click", () => emitSelection("add-to-chat"));
    popupNode.querySelector(".bsp-edit")?.addEventListener("click", () => emitSelection("quick-edit"));

    const popupWidget: any = {
      getId: () => "ba.selection.popup",
      getDomNode: () => popupNode,
      getPosition: () => {
        const sel = ed.getSelection();
        if (!sel || sel.isEmpty()) return null;
        // Anchor at the start of the selection so the popup floats above the
        // first selected line, the way Cursor does it.
        return {
          position: { lineNumber: sel.startLineNumber, column: sel.startColumn },
          preference: [
            monaco.editor.ContentWidgetPositionPreference.ABOVE,
            monaco.editor.ContentWidgetPositionPreference.BELOW,
          ],
        };
      },
    };
    let popupShown = false;
    function showPopup() {
      const sel = ed.getSelection();
      if (!sel || sel.isEmpty()) return;
      if (!popupShown) { ed.addContentWidget(popupWidget); popupShown = true; }
      else ed.layoutContentWidget(popupWidget);
    }
    function hidePopup() {
      if (popupShown) { ed.removeContentWidget(popupWidget); popupShown = false; }
    }
    // Hide as soon as selection collapses or changes mid-drag — only show
    // again on mouseup / keyup so the popup doesn't flicker while the user
    // is still dragging to extend the selection.
    ed.onDidChangeCursorSelection(() => {
      const sel = ed.getSelection();
      if (!sel || sel.isEmpty()) hidePopup();
      else if (popupShown) ed.layoutContentWidget(popupWidget);
    });
    ed.onMouseUp(() => {
      // Defer one tick so Monaco finishes updating the selection first.
      setTimeout(showPopup, 0);
    });
    ed.onKeyUp((e: any) => {
      // Only re-show on keys that can extend a selection (Shift held, arrows,
      // Home/End, etc.) — otherwise typing characters would re-open it.
      if (!e.shiftKey && e.keyCode !== 16 /* Shift */) return;
      setTimeout(showPopup, 0);
    });
    ed.onDidBlurEditorWidget(() => {
      if (popupNode.contains(document.activeElement)) return;
      hidePopup();
    });
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL, () => emitSelection("add-to-chat"));
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () => emitSelection("quick-edit"));
  };

  // Apply / clear inline diff decorations whenever the diff changes.
  useEffect(() => {
    const ed = editorRef.current;
    const monaco = monacoRef.current;
    if (!ed || !monaco) return;

    // Clear previous view zones, decorations, and per-hunk action widgets.
    ed.changeViewZones((acc: any) => {
      for (const id of viewZoneIdsRef.current) acc.removeZone(id);
    });
    viewZoneIdsRef.current = [];
    decorationsRef.current = ed.deltaDecorations(decorationsRef.current, []);
    for (const w of hunkWidgetsRef.current) {
      try { ed.removeContentWidget(w); } catch { /* noop */ }
    }
    hunkWidgetsRef.current = [];

    if (!pendingDiff) return;
    const hunks = parsePendingDiff(pendingDiff);
    if (hunks.length === 0) return;

    // Highlight added lines green (collected across all hunks).
    const decorations = hunks.flatMap((h) =>
      h.addedLines.map((line) => ({
        range: new monaco.Range(line, 1, line, 1),
        options: {
          isWholeLine: true,
          className: "ba-line-added",
          linesDecorationsClassName: "ba-gutter-added",
          marginClassName: "ba-margin-added",
        },
      })),
    );
    decorationsRef.current = ed.deltaDecorations([], decorations);

    // Insert red view zones for removed lines so the user sees what was deleted.
    ed.changeViewZones((acc: any) => {
      for (const h of hunks) {
        for (const block of h.removedBlocks) {
          const node = document.createElement("div");
          node.className = "ba-removed-zone";
          for (const ln of block.lines) {
            const row = document.createElement("div");
            row.className = "ba-removed-line";
            row.textContent = ln || " ";
            node.appendChild(row);
          }
          const id = acc.addZone({
            afterLineNumber: block.afterLine,
            heightInLines: block.lines.length,
            domNode: node,
          });
          viewZoneIdsRef.current.push(id);
        }
      }
    });

    // Per-hunk Keep / Undo content widgets, anchored above the first changed
    // line of each hunk. They emit `ba:hunk-action` so App.tsx can mutate
    // the corresponding DiffItem (and call /diff/revert-hunk when undoing).
    if (pendingDiffId) {
      const checkSvg = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m20 6-11 11-5-5"/></svg>`;
      const undoSvg = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>`;
      for (const h of hunks) {
        const node = document.createElement("div");
        node.className = "ba-hunk-actions";
        node.innerHTML = `
          <button type="button" class="bha-btn bha-keep" title="Accept this hunk — drop from pending list, file stays as-is">
            <span class="bha-icon">${checkSvg}</span><span>Keep</span>
          </button>
          <button type="button" class="bha-btn bha-undo" title="Undo just this hunk on disk">
            <span class="bha-icon">${undoSvg}</span><span>Undo</span>
          </button>
        `;
        node.addEventListener("mousedown", (e) => e.preventDefault());
        const fire = (action: "keep" | "undo") => {
          window.dispatchEvent(new CustomEvent("ba:hunk-action", {
            detail: { diffId: pendingDiffId, hunkIndex: h.index, action },
          }));
        };
        node.querySelector(".bha-keep")?.addEventListener("click", () => fire("keep"));
        node.querySelector(".bha-undo")?.addEventListener("click", () => fire("undo"));

        const widgetId = `ba.hunk.actions.${pendingDiffId}.${h.index}`;
        const widget = {
          getId: () => widgetId,
          getDomNode: () => node,
          getPosition: () => ({
            position: { lineNumber: h.anchorLine, column: 1 },
            preference: [
              monaco.editor.ContentWidgetPositionPreference.ABOVE,
              monaco.editor.ContentWidgetPositionPreference.BELOW,
            ],
          }),
        };
        ed.addContentWidget(widget);
        hunkWidgetsRef.current.push(widget);
      }
    }
  }, [pendingDiff, pendingDiffId, content, path]);

  if (error) return <div className="editor-empty">Error: {error}</div>;

  return (
    <Editor
      height="100%"
      theme="vs-dark"
      path={path}
      language={langFor(path)}
      value={content}
      onChange={(v) => setContent(v ?? "")}
      onMount={onMount}
      options={{
        fontSize: 13,
        minimap: { enabled: false },
        automaticLayout: true,
        scrollBeyondLastLine: false,
        wordWrap: "off",
      }}
    />
  );
});
