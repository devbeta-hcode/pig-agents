import Editor, { type OnMount } from "@monaco-editor/react";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";

import { api } from "../lib/api";

import {

  getFileBuffer,

  hasFileBuffer,

  invalidateEditorBuffer,

  isEditorDirty,

  shouldApplyDiskRead,

  writeFileBuffer,

  type FileBuffer,

} from "../lib/editorBuffer";



export {

  invalidateEditorBuffer as invalidateEditorCache,

  isPathDirtyInBuffer,

} from "../lib/editorBuffer";



interface Props {

  path: string;

  gotoLine?: number;

  onSaved?: () => void;

  /** Always includes this editor's `path` so tab dirty state cannot leak. */

  onDirtyChange?: (path: string, dirty: boolean) => void;

  pendingDiff?: string | null;

  pendingDiffId?: string | null;

  /** When `reloadSeq` bumps and `reloadPath === path`, force a disk re-read. */

  reloadPath?: string | null;

  reloadSeq?: number;

  onMissing?: () => void;

}



interface ParsedHunk {

  index: number;

  addedLines: number[];

  removedBlocks: { afterLine: number; lines: string[] }[];

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

      if (pendingDel.length === 0) pendingDelAnchor = modLine - 1;

      pendingDel.push(text);

    }

  }

  pushCur();



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



/** Monaco applies programmatic value updates asynchronously; ignore spurious change events until then. */

function endDiskApplyFlag(setter: (v: boolean) => void): void {

  requestAnimationFrame(() => {

    requestAnimationFrame(() => { setter(false); });

  });

}



export const FileEditor = forwardRef<FileEditorHandle, Props>(function FileEditor(

  {

    path,

    gotoLine,

    onSaved,

    onDirtyChange,

    pendingDiff,

    pendingDiffId,

    reloadPath,

    reloadSeq = 0,

    onMissing,

  },

  ref,

) {

  const initialBuf = getFileBuffer(path);

  const [content, setContent] = useState<string>(initialBuf?.content ?? "");

  const [original, setOriginal] = useState<string>(initialBuf?.original ?? "");

  const [error, setError] = useState<string | null>(null);

  const [loading, setLoading] = useState<boolean>(!initialBuf);



  const editorRef = useRef<import("monaco-editor").editor.IStandaloneCodeEditor | null>(null);

  const monacoRef = useRef<typeof import("monaco-editor") | null>(null);

  const decorationsRef = useRef<string[]>([]);

  const viewZoneIdsRef = useRef<string[]>([]);

  const hunkWidgetsRef = useRef<any[]>([]);



  const contentRef = useRef(content);

  const originalRef = useRef(original);

  useEffect(() => { contentRef.current = content; }, [content]);

  useEffect(() => { originalRef.current = original; }, [original]);



  const onDirtyChangeRef = useRef(onDirtyChange);

  const onSavedRef = useRef(onSaved);

  const onMissingRef = useRef(onMissing);

  const modelListenerRef = useRef<{ dispose: () => void } | null>(null);

  const applyingFromDiskRef = useRef(false);

  const prevReloadSeqRef = useRef(0);



  useEffect(() => { onDirtyChangeRef.current = onDirtyChange; }, [onDirtyChange]);

  useEffect(() => { onSavedRef.current = onSaved; }, [onSaved]);

  useEffect(() => { onMissingRef.current = onMissing; }, [onMissing]);



  const reportDirty = useCallback((nextContent: string, nextOriginal: string) => {

    onDirtyChangeRef.current?.(path, isEditorDirty(nextContent, nextOriginal));

  }, [path]);



  const applySnapshot = useCallback((snapshot: string, fromDisk: boolean) => {

    if (fromDisk) applyingFromDiskRef.current = true;

    writeFileBuffer(path, snapshot, snapshot);

    setContent(snapshot);

    setOriginal(snapshot);

    contentRef.current = snapshot;

    originalRef.current = snapshot;

    setLoading(false);

    reportDirty(snapshot, snapshot);

    if (fromDisk) endDiskApplyFlag((v) => { applyingFromDiskRef.current = v; });

  }, [path, reportDirty]);



  const applyBuffer = useCallback((buf: FileBuffer, fromDisk: boolean) => {

    if (fromDisk) applyingFromDiskRef.current = true;

    writeFileBuffer(path, buf.content, buf.original);

    setContent(buf.content);

    setOriginal(buf.original);

    contentRef.current = buf.content;

    originalRef.current = buf.original;

    setLoading(false);

    reportDirty(buf.content, buf.original);

    if (fromDisk) endDiskApplyFlag((v) => { applyingFromDiskRef.current = v; });

  }, [path, reportDirty]);



  useEffect(() => {

    writeFileBuffer(path, content, original);

  }, [path, content, original]);



  useEffect(() => {

    return () => {

      modelListenerRef.current?.dispose();

      modelListenerRef.current = null;

      writeFileBuffer(path, contentRef.current, originalRef.current);

      reportDirty(contentRef.current, originalRef.current);

    };

  }, [path, reportDirty]);



  // Initial open + background refresh when buffer is still clean.

  useEffect(() => {

    let cancelled = false;

    setError(null);



    const buf = getFileBuffer(path);

    if (buf) {

      applyBuffer(buf, true);

      if (isEditorDirty(buf.content, buf.original)) {

        return () => { cancelled = true; };

      }

    } else {

      setContent("");

      setOriginal("");

      setLoading(true);

    }



    void api.readFile(path)

      .then((r) => {

        if (cancelled) return;

        if (!shouldApplyDiskRead(path)) return;

        applySnapshot(r.content, true);

      })

      .catch((err) => {

        if (cancelled) return;

        const msg = (err as Error).message ?? "";

        if (/ENOENT|no such file/i.test(msg)) {

          invalidateEditorBuffer(path);

          onMissingRef.current?.();

          return;

        }

        setError(msg);

        setLoading(false);

      });



    return () => { cancelled = true; };

  }, [path, applyBuffer, applySnapshot]);



  // Targeted disk reload (e.g. after revert-hunk) — only for matching path.

  useEffect(() => {

    if (!reloadSeq || reloadPath !== path) return;

    if (reloadSeq <= prevReloadSeqRef.current) return;

    prevReloadSeqRef.current = reloadSeq;



    let cancelled = false;

    void api.readFile(path)

      .then((r) => {

        if (cancelled) return;

        applySnapshot(r.content, true);

      })

      .catch((err) => {

        if (cancelled) return;

        const msg = (err as Error).message ?? "";

        if (/ENOENT|no such file/i.test(msg)) {

          invalidateEditorBuffer(path);

          onMissingRef.current?.();

          return;

        }

        setError(msg);

      });



    return () => { cancelled = true; };

  }, [reloadSeq, reloadPath, path, applySnapshot]);



  useEffect(() => {

    if (gotoLine && editorRef.current) {

      const ed = editorRef.current;

      ed.revealLineInCenter(gotoLine);

      ed.setPosition({ lineNumber: gotoLine, column: 1 });

      ed.focus();

    }

  }, [gotoLine]);



  const save = useCallback(async () => {

    if (!isEditorDirty(contentRef.current, originalRef.current)) return;

    try {

      const snapshot = contentRef.current;

      await api.writeFile(path, snapshot);

      applySnapshot(snapshot, false);

      onSavedRef.current?.();

    } catch (err) {

      setError((err as Error).message);

    }

  }, [path, applySnapshot]);



  const syncFromModel = useCallback((next: string) => {

    setContent(next);

    writeFileBuffer(path, next, originalRef.current);

    reportDirty(next, originalRef.current);

  }, [path, reportDirty]);



  function insertAtCursor(text: string) {

    const ed = editorRef.current;

    if (!ed) {

      setContent((c) => {

        const next = c + (c.endsWith("\n") || !c ? "" : "\n") + text;

        writeFileBuffer(path, next, originalRef.current);

        reportDirty(next, originalRef.current);

        return next;

      });

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

      syncFromModel(text);

      return;

    }

    const model = ed.getModel();

    if (!model) {

      syncFromModel(text);

      return;

    }

    ed.executeEdits("ba-replace-all", [{ range: model.getFullModelRange(), text, forceMoveMarkers: true }]);

    ed.focus();

  }



  useImperativeHandle(

    ref,

    () => ({ save, insertAtCursor, replaceAll, getPath: () => path }),

    [path, save],

  );



  const onMount: OnMount = (ed, monaco) => {

    editorRef.current = ed;

    monacoRef.current = monaco;

    modelListenerRef.current?.dispose();



    const model = ed.getModel();

    if (model) {

      modelListenerRef.current = model.onDidChangeContent((e) => {

        if (e.isFlush || applyingFromDiskRef.current) return;

        syncFromModel(model.getValue());

      });

    }



    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { void save(); });

    if (gotoLine) {

      ed.revealLineInCenter(gotoLine);

      ed.setPosition({ lineNumber: gotoLine, column: 1 });

    }



    function emitSelection(kind: "add-to-chat" | "quick-edit") {

      const sel = ed.getSelection();

      if (!sel || sel.isEmpty()) return;

      const m = ed.getModel();

      if (!m) return;

      const text = m.getValueInRange(sel);

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

    popupNode.addEventListener("mousedown", (e) => e.preventDefault());

    popupNode.querySelector(".bsp-add")?.addEventListener("click", () => emitSelection("add-to-chat"));

    popupNode.querySelector(".bsp-edit")?.addEventListener("click", () => emitSelection("quick-edit"));



    const popupWidget = {

      getId: () => "ba.selection.popup",

      getDomNode: () => popupNode,

      getPosition: () => {

        const sel = ed.getSelection();

        if (!sel || sel.isEmpty()) return null;

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

    ed.onDidChangeCursorSelection(() => {

      const sel = ed.getSelection();

      if (!sel || sel.isEmpty()) hidePopup();

      else if (popupShown) ed.layoutContentWidget(popupWidget);

    });

    ed.onMouseUp(() => { setTimeout(showPopup, 0); });

    ed.onKeyUp((e) => {

      if (!e.shiftKey && e.keyCode !== 16) return;

      setTimeout(showPopup, 0);

    });

    ed.onDidBlurEditorWidget(() => {

      if (popupNode.contains(document.activeElement)) return;

      hidePopup();

    });

    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL, () => emitSelection("add-to-chat"));

    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () => emitSelection("quick-edit"));

  };



  useEffect(() => {

    const ed = editorRef.current;

    const monaco = monacoRef.current;

    if (!ed || !monaco) return;



    ed.changeViewZones((acc) => {

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



    ed.changeViewZones((acc) => {

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

          viewZoneIdsRef.current.push(acc.addZone({

            afterLineNumber: block.afterLine,

            heightInLines: block.lines.length,

            domNode: node,

          }));

        }

      }

    });



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



        const widget = {

          getId: () => `ba.hunk.actions.${pendingDiffId}.${h.index}`,

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



  const showLoadOverlay = loading && content === "" && original === "" && !hasFileBuffer(path);



  return (

    <div className="editor-host" style={{ position: "relative", height: "100%", width: "100%" }}>

      <Editor

        height="100%"

        theme="vs-dark"

        path={path}

        language={langFor(path)}

        value={content}

        onMount={onMount}

        options={{

          fontSize: 13,

          minimap: { enabled: false },

          automaticLayout: true,

          scrollBeyondLastLine: false,

          wordWrap: "off",

          readOnly: showLoadOverlay,

        }}

      />

      {showLoadOverlay && (

        <div className="editor-loading-overlay" aria-hidden="true">

          <span className="explorer-spinner" />

          <span className="editor-loading-text">Loading {path.split("/").pop() || path}…</span>

        </div>

      )}

    </div>

  );

});

