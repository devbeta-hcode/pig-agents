import { forwardRef, useEffect, useState, type ComponentProps } from "react";
import { api } from "../lib/api";
import { Markdown } from "./Markdown";
import { FileEditor, type FileEditorHandle } from "./Editor";
import { getFileBuffer } from "../lib/editorBuffer";

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg", "avif"]);
const MD_EXT = new Set(["md", "markdown", "mdx"]);
const extOf = (p: string): string => (p.split(".").pop() ?? "").toLowerCase();

export const isImagePath = (p: string): boolean => IMAGE_EXT.has(extOf(p));
export const isMarkdownPath = (p: string): boolean => MD_EXT.has(extOf(p));

/** In-editor image preview (PNG/JPG/GIF/SVG/WebP…) read as base64 over IPC. */
export function ImageViewer({ path }: { path: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    setErr(null);
    api
      .readFileBase64(path)
      .then((r) => {
        if (!cancelled) setSrc(`data:${r.mime};base64,${r.base64}`);
      })
      .catch((e) => {
        if (!cancelled) setErr((e as Error).message ?? String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  if (err) return <div className="editor-empty">Cannot show image: {err}</div>;
  return (
    <div className="image-viewer">
      {src ? (
        <img src={src} alt={path.split("/").pop() ?? path} />
      ) : (
        <div className="editor-empty">Loading image…</div>
      )}
    </div>
  );
}

/** Rendered markdown — reads the live editor buffer (so source edits show) or disk. */
function MarkdownPreview({ path }: { path: string }) {
  const [content, setContent] = useState<string>(() => getFileBuffer(path)?.content ?? "");
  useEffect(() => {
    let cancelled = false;
    const buf = getFileBuffer(path);
    if (buf) {
      setContent(buf.content);
      return;
    }
    api
      .readFile(path)
      .then((r) => {
        if (!cancelled) setContent(r.content);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [path]);
  return (
    <div className="md-preview">
      <Markdown>{content}</Markdown>
    </div>
  );
}

type MarkdownViewProps = ComponentProps<typeof FileEditor>;

/** Markdown tab with a Cursor/VS Code–style Preview ⇆ Source toggle. */
export const MarkdownView = forwardRef<FileEditorHandle, MarkdownViewProps>(function MarkdownView(props, ref) {
  const [mode, setMode] = useState<"preview" | "source">("preview");
  return (
    <div className="md-view">
      <div className="md-view-toolbar">
        <button
          type="button"
          className={`md-view-tab ${mode === "preview" ? "active" : ""}`}
          onClick={() => setMode("preview")}
        >
          Preview
        </button>
        <button
          type="button"
          className={`md-view-tab ${mode === "source" ? "active" : ""}`}
          onClick={() => setMode("source")}
        >
          Source
        </button>
      </div>
      <div className="md-view-body">
        {mode === "source" ? <FileEditor ref={ref} {...props} /> : <MarkdownPreview path={props.path} />}
      </div>
    </div>
  );
});
