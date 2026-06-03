import { useState, useEffect, useRef } from "react";
import { FileIcon } from "./FileIcon";

export interface ToolOutputProps {
  tool: string;
  input: Record<string, unknown>;
  /** The observation result - if provided, shows the output */
  observation?: {
    ok: boolean;
    summary: string;
    diffs?: string[];
  };
  /** Live merged chunks from command_chunk SSE before observation arrives */
  streamPreview?: string;
  /**
   * Partial patches / file body from the live token buffer (write_patch +
   * create_file) while ACTION JSON is still arriving.
   */
  streamingArgPreview?: string;
  /** Disk write finished (SSE tool_disk_settled) before observation is emitted. */
  diskSettledOk?: boolean;
  /** Turn ended but disk write never confirmed (broken ACTION JSON, etc.). */
  saveFailed?: boolean;
  /** Hide the Copilot-style top row — used when the row is rendered in `<summary>`. */
  suppressHeader?: boolean;
  /**
   * When one write_patch spans multiple FILES and we split the UI row-per-file,
   * only one row should surface observation follow-up (patch results / validation) to avoid duplication.
   */
  suppressObservationFollowup?: boolean;
}

export type ToolAccordionHeaderProps = Pick<
  ToolOutputProps,
  "tool" | "input" | "observation" | "streamPreview" | "streamingArgPreview" | "diskSettledOk" | "saveFailed"
>;

// Icons as simple SVG components
const icons = {
  file: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <path d="M2 1.75C2 .784 2.784 0 3.75 0h5.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 8.75 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914-.013-.011Z" opacity="0.85" />
    </svg>
  ),
  edit: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <path d="M13.23 1h-1.46L3.52 9.25l-.16.22L1 13.59 2.41 15l4.12-2.36.22-.16L15 4.23V2.77L13.23 1zM2.41 13.59l1.51-3 1.45 1.45-2.96 1.55zm3.83-2.06L4.47 9.76l8-8 1.77 1.77-8 8z"/>
    </svg>
  ),
  terminal: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <path d="M0 2.75C0 1.784.784 1 1.75 1h12.5c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0 1 14.25 15H1.75A1.75 1.75 0 0 1 0 13.25V2.75zm1.75-.25a.25.25 0 0 0-.25.25v10.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25V2.75a.25.25 0 0 0-.25-.25H1.75zM7.25 8a.75.75 0 0 1-.22.53l-2.25 2.25a.75.75 0 1 1-1.06-1.06L5.44 8 3.72 6.28a.75.75 0 1 1 1.06-1.06l2.25 2.25c.141.14.22.331.22.53zm1.5 1.5a.75.75 0 0 1 0-1.5h3.5a.75.75 0 0 1 0 1.5h-3.5z"/>
    </svg>
  ),
  search: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0z"/>
    </svg>
  ),
  folder: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <path d="M.54 3.87.5 14a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1V4.5a1 1 0 0 0-1-1H6.414l-.914-.914A2 2 0 0 0 4.086 2H1.5a1 1 0 0 0-1 1v.87z"/>
    </svg>
  ),
  map: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8.235 1.559a.5.5 0 0 0-.47 0l-7.5 4a.5.5 0 0 0 0 .882L3.188 8 .264 9.559a.5.5 0 0 0 0 .882l7.5 4a.5.5 0 0 0 .47 0l7.5-4a.5.5 0 0 0 0-.882L12.813 8l2.922-1.559a.5.5 0 0 0 0-.882l-7.5-4zM8 9.433 1.562 6 8 2.567 14.438 6 8 9.433z"/>
    </svg>
  ),
  check: (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
      <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0z"/>
    </svg>
  ),
  error: (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
      <path d="M4.47.22A.75.75 0 0 1 5 0h6a.75.75 0 0 1 .53.22l4.25 4.25c.141.14.22.331.22.53v6a.75.75 0 0 1-.22.53l-4.25 4.25A.75.75 0 0 1 11 16H5a.75.75 0 0 1-.53-.22L.22 11.53A.75.75 0 0 1 0 11V5a.75.75 0 0 1 .22-.53L4.47.22zm.84 1.28L1.5 5.31v5.38l3.81 3.81h5.38l3.81-3.81V5.31L10.69 1.5H5.31zM8 4a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 8 4zm0 8a1 1 0 1 1 0-2 1 1 0 0 1 0 2z"/>
    </svg>
  ),
};

function CodeBlock({ content, language, maxLines = 12 }: { content: string; language?: string; maxLines?: number }) {
  const [expanded, setExpanded] = useState(false);
  const lines = content.split("\n");
  const needsTruncate = lines.length > maxLines;
  const displayContent = expanded || !needsTruncate 
    ? content 
    : lines.slice(0, maxLines).join("\n") + "\n…";

  return (
    <div className="tool-code-block">
      <pre className={`language-${language || "text"}`}>
        <code>{displayContent}</code>
      </pre>
      {needsTruncate && (
        <button 
          className="tool-code-expand"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Show less" : `Show ${lines.length - maxLines} more lines`}
        </button>
      )}
    </div>
  );
}

function StatusBadge({ ok, label }: { ok: boolean; label?: string }) {
  return (
    <span className={`tool-status ${ok ? "tool-status--ok" : "tool-status--fail"}`}>
      {ok ? icons.check : icons.error}
      <span>{label || (ok ? "Done" : "Failed")}</span>
    </span>
  );
}

/** Line-kind styling for streamed patch/diff-ish text (+ unified hunks vs FILE:/SEARCH markers). */
function patchStreamLineClass(line: string): string {
  const t = line.replace(/\r$/, "");
  if (/^FILE:\s/i.test(t)) return "tool-patch-line-file-header";
  const trimEnd = t.trimEnd();
  if (trimEnd === "SEARCH") return "tool-patch-line-marker";
  if (trimEnd === "REPLACE") return "tool-patch-line-marker tool-patch-line-marker-replace";
  if (trimEnd === "END") return "tool-patch-line-marker";
  if (/^diff --git\b/.test(t) || /^index [\da-f]{7,}\b/i.test(t)) return "tool-patch-line-meta";
  if (/^---\s/.test(t) || /^\+\+\+\s/.test(t)) return "tool-patch-line-meta";
  if (t.startsWith("@@")) return "tool-patch-line-hunk";
  if (t.startsWith("+")) return "tool-patch-line-add";
  if (t.startsWith("-")) return "tool-patch-line-del";
  if (/^ /.test(t)) return "tool-patch-line-ctx";
  return "tool-patch-line-content";
}

function PatchStreamHighlighted({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <>
      {lines.map((line, i) => (
        <span key={i} className={`tool-patch-stream-line ${patchStreamLineClass(line)}`}>
          {line}
          {i < lines.length - 1 ? "\n" : ""}
        </span>
      ))}
    </>
  );
}

function firstRelativePathFromPatchStream(text: string): string | undefined {
  const m = text.match(/^FILE:\s*(.+)$/m);
  return m?.[1]?.trim() || undefined;
}

// Renders read_file tool output
function ReadFileOutput({
  input,
  observation,
  suppressHeader,
}: {
  input: Record<string, unknown>;
  observation?: ToolOutputProps["observation"];
  suppressHeader?: boolean;
}) {
  const path = String(input.path || "");
  const fileName = path.split("/").pop() || path;

  // The executor returns one of:
  //   "<path> (<N>c[, cached]):\n<file content>"  — success
  //   "read_file error: <msg>\n[!] hint…"         — failure
  // Strip the path-header line for success; show error+hint as-is for failure.
  const rawSummary = observation?.summary ?? "";
  const isError = !observation?.ok;
  const content = isError
    ? rawSummary
    : rawSummary.replace(/^[^\n]*\(\d+c[^)]*\):\s*\n?/, "");

  return (
    <div className="tool-output tool-read-file">
      {!suppressHeader && (
      <div className="tool-header">
        <span className="tool-icon">{icons.file}</span>
        <span className="tool-action">Read</span>
        <span className="tool-target">
          <FileIcon name={fileName} size={14} />
          <span className="tool-path" title={path}>{path}</span>
        </span>
        {observation ? (
          <StatusBadge ok={observation.ok} />
        ) : (
          <span className="tool-status tool-status--streaming">reading…</span>
        )}
      </div>
      )}
      {observation && content && (
        <div className={`tool-details ${isError ? "tool-inline-body-read tool-inline-body-read--error" : "tool-inline-body-read"}`}>
          {/* Outer timeline accordion handles collapse — no nested Show/Hide row. */}
          {isError ? (
            <pre className="tool-error-pre">{content}</pre>
          ) : (
            <CodeBlock content={content} language={guessLanguage(fileName)} />
          )}
        </div>
      )}
    </div>
  );
}

/** Prefer live token peek while OBSERVATION is pending so the pre keeps up with the model buffer. */
function pickCreateFileStreamBody(
  observation: ToolOutputProps["observation"] | undefined,
  fullContent: string,
  streamingArgPreview: string | undefined,
): string {
  if (observation != null) return fullContent;
  const peek = streamingArgPreview ?? "";
  if (peek.length > fullContent.length) return peek;
  if (fullContent.length > 0) return fullContent;
  return peek;
}

function pickPatchStreamBody(
  observation: ToolOutputProps["observation"] | undefined,
  fullPatches: string,
  streamingArgPreview: string | undefined,
): string {
  if (observation != null) return fullPatches;
  const peek = streamingArgPreview ?? "";
  if (peek.length > fullPatches.length) return peek;
  if (fullPatches.length > 0) return fullPatches;
  return peek;
}

/** Shared file chip list for write_patch header + accordion summary. */
function writePatchHeaderFileLists(
  input: Record<string, unknown>,
  observation: ToolOutputProps["observation"] | undefined,
  streamingArgPreview: string | undefined,
): { chips: string[]; okFiles: string[]; failFiles: string[] } {
  const patches = String(input.patches || input.patch || "");
  const targetPatches = pickPatchStreamBody(observation, patches, streamingArgPreview);
  const peekFiles = (targetPatches.match(/FILE:\s*([^\n]+)/g) || []).map((m) =>
    m.replace(/^FILE:\s*/i, "").trim(),
  );
  const filesFromInput =
    patches.match(/FILE:\s*([^\n]+)/g)?.map((m) => m.replace(/^FILE:\s*/i, "").trim()) ?? [];
  const files = peekFiles.length > 0 ? peekFiles : filesFromInput;
  const okFiles = observation?.summary?.match(/OK ([^\n]+)/g)?.map((m) => m.replace("OK ", "")) || [];
  const failFiles =
    observation?.summary?.match(/FAIL ([^\n:]+)/g)?.map((m) => m.replace("FAIL ", "").split(":")[0]) || [];
  const chipSource = files.length > 0 ? files : [...okFiles, ...failFiles];
  return { chips: chipSource, okFiles, failFiles };
}

// Renders create_file — typewriter + streamingArgPreview in ToolOutput; Thinking stays THOUGHT-only.
function CreateFileOutput({
  input,
  observation,
  streamingArgPreview,
  diskSettledOk,
  saveFailed,
  suppressHeader,
}: {
  input: Record<string, unknown>;
  observation?: ToolOutputProps["observation"];
  streamingArgPreview?: string;
  diskSettledOk?: boolean;
  saveFailed?: boolean;
  suppressHeader?: boolean;
}) {
  const filePath = String(input.path || "");
  const fileName = filePath.split("/").pop() || filePath;
  const fullContent = String(input.content ?? "");
  const targetContent = pickCreateFileStreamBody(observation, fullContent, streamingArgPreview);
  const lang = guessLanguage(fileName);
  const streamPreRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    if (streamPreRef.current) streamPreRef.current.scrollTop = streamPreRef.current.scrollHeight;
  }, [targetContent]);

  const showStreamShell = !observation;

  return (
    <div className="tool-output tool-create-file">
      {!suppressHeader && (
      <div className="tool-header">
        <span className="tool-icon tool-icon--edit">{icons.edit}</span>
        <span className="tool-action">Create</span>
        <span className="tool-target">
          <FileIcon name={fileName} size={14} />
          <span className="tool-path" title={filePath}>{filePath}</span>
        </span>
        {observation ? (
          <StatusBadge ok={observation.ok} />
        ) : saveFailed ? (
          <span className="tool-status tool-status--fail">not saved</span>
        ) : diskSettledOk === true ? (
          <span className="tool-status tool-status--streaming">saved…</span>
        ) : (
          <span className="tool-status tool-status--streaming">writing…</span>
        )}
      </div>
      )}

      {showStreamShell && (
        <div className="tool-create-stream">
          <pre ref={streamPreRef} className="tool-command-stream tool-create-content tool-stream-pre-inner">
            <code>
              {targetContent.trim() ? (
                targetContent
              ) : (
                <span className="tool-stream-placeholder">Receiving file content…</span>
              )}
            </code>
          </pre>
        </div>
      )}

      {observation && fullContent && (
        <div className="tool-details tool-inline-body-create">
          <div className="tool-code-block">
            <pre className={`language-${lang}`} style={{ maxHeight: 280, overflow: "auto" }}>
              <code>{fullContent}</code>
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

/** Count +/- lines in a unified diff body (skips file headers and hunk markers). */
export function countDiffStats(diff: string | undefined): { add: number; del: number } | null {
  if (!diff) return null;
  let add = 0,
    del = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) add++;
    else if (line.startsWith("-")) del++;
  }
  if (add === 0 && del === 0) return null;
  return { add, del };
}

export function aggregateDiffStats(diffs: string[] | undefined): { add: number; del: number } | null {
  if (!diffs?.length) return null;
  let add = 0,
    del = 0;
  for (const d of diffs) {
    const s = countDiffStats(d);
    if (s) {
      add += s.add;
      del += s.del;
    }
  }
  if (add === 0 && del === 0) return null;
  return { add, del };
}

function diffPathBasename(diff: string): string {
  for (const ln of diff.split("\n")) {
    if (ln.startsWith("+++ b/")) return ln.slice(6).trim().split("/").pop() || ln.slice(6).trim();
    if (ln.startsWith("+++ ")) return ln.slice(4).trim().split("/").pop() || ln.slice(4).trim();
  }
  return "";
}

/** Per-file diff — `compact` drops nested filename/stats (shown in parent header). */
function PatchDiffList({ diffs, compact }: { diffs: string[]; compact?: boolean }) {
  return (
    <div className={`tool-patch-diffs${compact ? " tool-patch-diffs--compact" : ""}`}>
      {diffs.map((d, i) => (
        <PatchDiffBlock key={i} diff={d} compact={compact} />
      ))}
    </div>
  );
}

function PatchDiffBlock({ diff, compact }: { diff: string; compact?: boolean }) {
  const [open, setOpen] = useState(true);
  const lines = diff.split("\n");
  let path = "";
  for (const ln of lines) {
    if (ln.startsWith("+++ b/")) {
      path = ln.slice(6).trim();
      break;
    }
    if (ln.startsWith("+++ ")) {
      path = ln.slice(4).trim();
      break;
    }
  }
  const stats = countDiffStats(diff);
  const body = (
    <pre className="tool-diff-body language-diff">
      <code>
        <PatchStreamHighlighted text={diff} />
      </code>
    </pre>
  );
  if (compact) {
    return <div className="tool-diff-flat">{body}</div>;
  }
  return (
    <details className="tool-diff-block" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="tool-diff-summary">
        <span className="tool-diff-chev" aria-hidden>{open ? "▾" : "▸"}</span>
        {path && <FileIcon name={path.split("/").pop() || path} size={12} />}
        <span className="tool-diff-path">{path || "diff"}</span>
        {stats && (
          <span className="tool-patch-stats">
            <span className="tool-patch-stats-add">+{stats.add}</span>
            <span className="tool-patch-stats-del">−{stats.del}</span>
          </span>
        )}
      </summary>
      {body}
    </details>
  );
}

// Renders write_patch — live stream in <pre.tool-patch-stream> (streamingArgPreview → full patches) until observation.
function WritePatchOutput({
  input,
  observation,
  streamingArgPreview,
  diskSettledOk,
  suppressHeader,
  suppressObservationFollowup,
}: {
  input: Record<string, unknown>;
  observation?: ToolOutputProps["observation"];
  streamingArgPreview?: string;
  diskSettledOk?: boolean;
  suppressHeader?: boolean;
  suppressObservationFollowup?: boolean;
}) {
  const patches = String(input.patches || input.patch || "");
  const targetPatches = pickPatchStreamBody(observation, patches, streamingArgPreview);

  const { chips, okFiles, failFiles } = writePatchHeaderFileLists(input, observation, streamingArgPreview);

  /** Live patch text tracks the model buffer directly — no typewriter (avoids absurd "FIL…" as FILE: arrives). */
  const showLivePre = !observation && targetPatches.length > 0;

  const patchPreRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    const el = patchPreRef.current;
    if (!el || observation || !showLivePre) return;
    el.scrollTop = el.scrollHeight;
  }, [targetPatches, observation, showLivePre]);

  const headerRow = (
    <ToolAccordionHeader
      tool="write_patch"
      input={input}
      observation={observation}
      streamingArgPreview={streamingArgPreview}
      diskSettledOk={diskSettledOk}
    />
  );

  return (
    <div className="tool-output tool-write-patch">
      {!suppressHeader && !observation?.diffs?.length && (
        <div className="tool-header">{headerRow}</div>
      )}
      {showLivePre && (
        <div className="tool-create-stream">
          <div className="tool-patch-file-banner" aria-label="Streaming patch target">
            {(() => {
              const bp = firstRelativePathFromPatchStream(targetPatches);
              if (!bp) return <span className="tool-patch-file-banner-placeholder">Patch stream</span>;
              return (
                <>
                  <FileIcon name={bp.split("/").pop() || bp} size={13} />
                  <span className="tool-patch-file-banner-path">{bp}</span>
                </>
              );
            })()}
          </div>
          <pre ref={patchPreRef} className="tool-command-stream tool-patch-stream tool-stream-pre-inner language-diff">
            <code>
              <PatchStreamHighlighted text={targetPatches} />
            </code>
          </pre>
        </div>
      )}
      {observation && !suppressObservationFollowup && (
        <div className="tool-details tool-inline-body-patch">
          {observation.diffs && observation.diffs.length > 0 ? (
            <PatchDiffList diffs={observation.diffs} compact={suppressHeader} />
          ) : (
            <div className="tool-patch-results">
              {okFiles.map((f, i) => (
                <div key={i} className="tool-patch-file tool-patch-file--ok">
                  <span className="tool-patch-status">{icons.check}</span>
                  <FileIcon name={f.split("/").pop() || ""} size={12} />
                  <span>{f}</span>
                </div>
              ))}
              {failFiles.map((f, i) => (
                <div key={i} className="tool-patch-file tool-patch-file--fail">
                  <span className="tool-patch-status">{icons.error}</span>
                  <FileIcon name={f.split("/").pop() || ""} size={12} />
                  <span>{f}</span>
                </div>
              ))}
            </div>
          )}
          {observation.summary?.includes("Validation:") && (
            <div className="tool-validation">
              <CodeBlock
                content={observation.summary.split("Validation:")[1]?.trim() || ""}
                maxLines={6}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Renders run_command tool output
function RunCommandOutput({
  input,
  observation,
  streamPreview,
  suppressHeader,
}: {
  input: Record<string, unknown>;
  observation?: ToolOutputProps["observation"];
  streamPreview?: string;
  suppressHeader?: boolean;
}) {
  const cmd = String(input.cmd || input.command || "");

  // Parse exit code and output from observation
  const exitMatch = observation?.summary?.match(/exit=(-?\d+)/);
  const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : null;
  const isBackground = observation?.summary?.includes("[BG]") || observation?.summary?.includes("[RUNNING IN BACKGROUND]");

  const outM = observation?.summary?.match(/\nout:\s*([\s\S]*?)(?=\nerr:|$)/i);
  const errM = observation?.summary?.match(/\nerr:\s*([\s\S]*?)(?=\n\[!]|$)/i);
  const stdout = outM?.[1]?.trim() || "";
  const stderr = errM?.[1]?.trim() || "";
  const legacyOut = observation?.summary?.match(/--- stdout ---\n([\s\S]*?)(?=\n--- stderr ---|$)/);
  const legacyErr = observation?.summary?.match(/--- stderr ---\n([\s\S]*?)(?=\n\[system\]|$)/);
  const stdoutF = stdout || legacyOut?.[1]?.trim() || "";
  const stderrF = stderr || legacyErr?.[1]?.trim() || "";
  const output = [stdoutF, stderrF].filter(Boolean).join("\n\n");

  const streamPreRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (!streamPreview || observation) return;
    const el = streamPreRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [streamPreview, observation]);

  const statusLabel = isBackground 
    ? "Running" 
    : exitCode === 0 
      ? "Done" 
      : exitCode !== null 
        ? `Exit ${exitCode}` 
        : undefined;

  return (
    <div className="tool-output tool-run-command">
      {!suppressHeader && (
      <div className="tool-header">
        <span className="tool-icon tool-icon--terminal">{icons.terminal}</span>
        <span className="tool-action">Run</span>
        <code className="tool-cmd" title={cmd}>
          {cmd.length > 60 ? cmd.slice(0, 57) + "…" : cmd}
        </code>
        {observation ? (
          <StatusBadge ok={observation.ok} label={statusLabel} />
        ) : (
          <span className="tool-status tool-status--streaming">running…</span>
        )}
      </div>
      )}
      {streamPreview && !observation && (
        <div className="tool-command-stream-wrap" aria-live="polite">
          <span className="tool-command-stream-label">Output…</span>
          <pre ref={streamPreRef} className="tool-command-stream">{streamPreview}</pre>
        </div>
      )}
      {observation && output && (
        <div className="tool-details tool-inline-body-run">
          <CodeBlock content={output} language="shell" maxLines={12} />
        </div>
      )}
    </div>
  );
}

function parseCodeHits(summary: string): { loc: string; text: string }[] {
  const body = summary.replace(/^search_code "[^"]*" \(\d+ hits\):\n?/i, "").trim();
  if (!body) return [];
  return body
    .split("\n")
    .filter(Boolean)
    .slice(0, 12)
    .map((line) => {
      const m = line.match(/^(.+?):(\d+):\s*(.*)$/);
      if (m) return { loc: `${m[1]}:${m[2]}`, text: m[3] ?? "" };
      return { loc: line.slice(0, 48), text: "" };
    });
}

function CodeHitList({ hits }: { hits: { loc: string; text: string }[] }) {
  if (!hits.length) return null;
  return (
    <ul className="tool-hit-list">
      {hits.map((h, i) => (
        <li key={i} className="tool-hit-row">
          <code className="tool-hit-loc">{h.loc}</code>
          {h.text ? <span className="tool-hit-snippet">{h.text}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function SemanticSearchOutput({
  input,
  observation,
  suppressHeader,
}: {
  input: Record<string, unknown>;
  observation?: ToolOutputProps["observation"];
  suppressHeader?: boolean;
}) {
  const query = String(input.query || "");
  const lines =
    observation?.summary
      ?.split("\n")
      .filter((l) => l.trim() && !/^semantic /i.test(l))
      .slice(0, 10) ?? [];
  return (
    <div className="tool-output tool-semantic-search">
      {!suppressHeader && (
        <div className="tool-header">
          <span className="tool-icon tool-icon--search">{icons.search}</span>
          <span className="tool-action">Semantic</span>
          <code className="tool-query">&quot;{query}&quot;</code>
          {observation ? (
            <span className="tool-hit-count">{lines.length} hits</span>
          ) : (
            <span className="tool-status tool-status--streaming">searching…</span>
          )}
        </div>
      )}
      {observation && lines.length > 0 && (
        <ul className="tool-hit-list">
          {lines.map((line, i) => (
            <li key={i} className="tool-hit-row tool-hit-row--semantic">
              <span className="tool-hit-snippet">{line.length > 140 ? `${line.slice(0, 137)}…` : line}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Renders search_code tool output
function SearchCodeOutput({
  input,
  observation,
  suppressHeader,
}: {
  input: Record<string, unknown>;
  observation?: ToolOutputProps["observation"];
  suppressHeader?: boolean;
}) {
  const query = String(input.query || "");

  // Parse hit count from observation
  const hitsMatch = observation?.summary?.match(/\((\d+) hits\)/);
  const hitCount = hitsMatch ? parseInt(hitsMatch[1], 10) : 0;
  
  // Extract search results
  const hits = observation?.summary ? parseCodeHits(observation.summary) : [];

  return (
    <div className="tool-output tool-search-code">
      {!suppressHeader && (
      <div className="tool-header">
        <span className="tool-icon tool-icon--search">{icons.search}</span>
        <span className="tool-action">Search</span>
        <code className="tool-query">"{query}"</code>
        {observation ? (
          <span className="tool-hit-count">{hitCount} matches</span>
        ) : (
          <span className="tool-status tool-status--streaming">searching…</span>
        )}
      </div>
      )}
      {observation && hits.length > 0 && (
        <div className="tool-details tool-inline-body-search">
          <CodeHitList hits={hits} />
        </div>
      )}
    </div>
  );
}

// Renders list_files tool output
function ListFilesOutput({
  input,
  observation,
  suppressHeader,
}: {
  input: Record<string, unknown>;
  observation?: ToolOutputProps["observation"];
  suppressHeader?: boolean;
}) {
  const dir = String(input.dir || ".");

  // Backend format: `"${dir}/:\n- file\nd subdir\n..."`. Strip the header line
  // (anything ending in `/:`) so the first entry isn't echoed as a phantom item,
  // and parse the `[d|-] path` prefix to detect directories.
  const rawSummary = observation?.summary || "";
  const content = rawSummary.replace(/^[^\n]+\/:\n?/, "");
  const lines = content.split("\n").filter(Boolean);
  const fileCount = lines.length;

  return (
    <div className="tool-output tool-list-files">
      {!suppressHeader && (
      <div className="tool-header">
        <span className="tool-icon tool-icon--folder">{icons.folder}</span>
        <span className="tool-action">List</span>
        <span className="tool-path" title={dir}>{dir}</span>
        {observation ? (
          <span className="tool-file-count">{fileCount} items</span>
        ) : (
          <span className="tool-status tool-status--streaming">listing…</span>
        )}
      </div>
      )}
      {observation && content && (
        <div className="tool-details tool-inline-body-list">
          <div className="tool-file-list">
            {lines.slice(0, 30).map((line, i) => {
              const m = /^([d-])\s+(.*)$/.exec(line);
              const isDir = m ? m[1] === "d" : false;
              const name = (m ? m[2] : line).trim();
              if (!name) return null;
              return (
                <div key={i} className="tool-file-item">
                  {isDir ? icons.folder : <FileIcon name={name} size={14} />}
                  <span>{name}</span>
                </div>
              );
            })}
            {lines.length > 30 && (
              <div className="tool-file-more-items">+{lines.length - 30} more items</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Renders codebase_map tool output
function CodebaseMapOutput({
  input,
  observation,
  suppressHeader,
}: {
  input: Record<string, unknown>;
  observation?: ToolOutputProps["observation"];
  suppressHeader?: boolean;
}) {
  const maxDepth = input.max_depth || input.depth || 5;

  return (
    <div className="tool-output tool-codebase-map">
      {!suppressHeader && (
      <div className="tool-header">
        <span className="tool-icon tool-icon--map">{icons.map}</span>
        <span className="tool-action">Codebase Map</span>
        <span className="tool-depth">depth: {String(maxDepth)}</span>
        {observation ? (
          <StatusBadge ok={observation.ok} />
        ) : (
          <span className="tool-status tool-status--streaming">mapping…</span>
        )}
      </div>
      )}
      {observation?.summary && (
        <div className="tool-details tool-codebase-map-body">
          {/* Outer timeline accordion already hides/shows payload — skip nested toggle. */}
          <CodeBlock content={observation.summary} maxLines={30} />
        </div>
      )}
    </div>
  );
}

// Guess language from filename for syntax highlighting
function guessLanguage(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
    py: "python", rb: "ruby", go: "go", rs: "rust",
    java: "java", kt: "kotlin", swift: "swift",
    css: "css", scss: "scss", less: "less",
    html: "html", vue: "vue", svelte: "svelte",
    json: "json", yaml: "yaml", yml: "yaml", toml: "toml",
    md: "markdown", sql: "sql", sh: "bash", bash: "bash",
    dockerfile: "dockerfile", makefile: "makefile",
  };
  return map[ext] || "text";
}

/** Row for `<summary>` — keep in sync with each tool’s `suppressHeader={false}` header. */
export function ToolAccordionHeader({
  tool,
  input,
  observation,
  streamingArgPreview,
  diskSettledOk,
  saveFailed,
}: ToolAccordionHeaderProps): JSX.Element | null {
  const t = tool.toLowerCase();

  if (t === "read_file") {
    const path = String(input.path || "");
    const fileName = path.split("/").pop() || path;
    return (
      <span className="tool-flat-head">
        <span className="tool-action">Read</span>
        <FileIcon name={fileName} size={14} />
        <span className="tool-flat-name" title={path}>
          {fileName}
        </span>
        {!observation ? (
          <span className="tool-status tool-status--streaming">reading…</span>
        ) : !observation.ok ? (
          <StatusBadge ok={false} />
        ) : null}
      </span>
    );
  }

  if (t === "create_file") {
    const filePath = String(input.path || "");
    const fileName = filePath.split("/").pop() || filePath;
    const stats = aggregateDiffStats(observation?.diffs);
    return (
      <span className="tool-flat-head">
        <span className="tool-action">Create</span>
        <FileIcon name={fileName} size={14} />
        <span className="tool-flat-name" title={filePath}>
          {fileName}
        </span>
        {stats && (
          <span className="tool-flat-stats">
            <span className="tool-patch-stats-add">+{stats.add}</span>
            <span className="tool-patch-stats-del">−{stats.del}</span>
          </span>
        )}
        {!observation ? (
          saveFailed ? (
            <span className="tool-status tool-status--fail">not saved</span>
          ) : diskSettledOk === true ? (
            <span className="tool-status tool-status--streaming">saved…</span>
          ) : (
            <span className="tool-status tool-status--streaming">writing…</span>
          )
        ) : !observation.ok ? (
          <StatusBadge ok={false} />
        ) : null}
      </span>
    );
  }

  if (t === "write_patch") {
    const { chips, okFiles, failFiles } = writePatchHeaderFileLists(input, observation, streamingArgPreview);
    const primary =
      chips[0] ||
      okFiles[0] ||
      failFiles[0] ||
      (observation?.diffs?.[0] ? diffPathBasename(observation.diffs[0]) : "") ||
      "";
    const base = primary.split("/").pop() || primary || "file";
    const stats = aggregateDiffStats(observation?.diffs);
    return (
      <span className="tool-flat-head">
        <span className="tool-action">Edit</span>
        <FileIcon name={base} size={14} />
        <span className="tool-flat-name" title={primary}>
          {base}
        </span>
        {chips.length > 1 && <span className="tool-flat-more">+{chips.length - 1}</span>}
        {stats && (
          <span className="tool-flat-stats">
            <span className="tool-patch-stats-add">+{stats.add}</span>
            <span className="tool-patch-stats-del">−{stats.del}</span>
          </span>
        )}
        {!observation ? (
          diskSettledOk === true ? (
            <span className="tool-status tool-status--streaming">saved…</span>
          ) : (
            <span className="tool-status tool-status--streaming">writing…</span>
          )
        ) : !observation.ok ? (
          <StatusBadge ok={false} />
        ) : null}
      </span>
    );
  }

  if (t === "run_command") {
    const cmd = String(input.cmd || input.command || "");
    const exitMatch = observation?.summary?.match(/exit=(-?\d+)/);
    const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : null;
    const isBackground =
      observation?.summary?.includes("[BG]") || observation?.summary?.includes("[RUNNING IN BACKGROUND]");
    const statusLabel = isBackground
      ? "Running"
      : exitCode === 0
        ? "Done"
        : exitCode !== null
          ? `Exit ${exitCode}`
          : undefined;
    return (
      <span className="tool-flat-head">
        <span className="tool-action">Run</span>
        <span className="tool-icon tool-icon--terminal">{icons.terminal}</span>
        <code className="tool-cmd" title={cmd}>
          {cmd.length > 60 ? cmd.slice(0, 57) + "…" : cmd}
        </code>
        {observation ? (
          <StatusBadge ok={observation.ok} label={statusLabel} />
        ) : (
          <span className="tool-status tool-status--streaming">running…</span>
        )}
      </span>
    );
  }

  if (t === "search_code") {
    const query = String(input.query || "");
    const hitsMatch = observation?.summary?.match(/\((\d+) hits\)/);
    const hitCount = hitsMatch ? parseInt(hitsMatch[1], 10) : 0;
    return (
      <span className="tool-flat-head">
        <span className="tool-action">Search</span>
        <span className="tool-icon tool-icon--search">{icons.search}</span>
        <code className="tool-query">&quot;{query}&quot;</code>
        {observation ? (
          <span className="tool-hit-count">{hitCount} matches</span>
        ) : (
          <span className="tool-status tool-status--streaming">searching…</span>
        )}
      </span>
    );
  }

  if (t === "list_files") {
    const dir = String(input.dir || ".");
    const rawSummary = observation?.summary || "";
    const content = rawSummary.replace(/^[^\n]+\/:\n?/, "");
    const fileCount = content.split("\n").filter(Boolean).length;
    return (
      <span className="tool-flat-head">
        <span className="tool-action">List</span>
        <span className="tool-icon tool-icon--folder">{icons.folder}</span>
        <span className="tool-path" title={dir}>
          {dir}
        </span>
        {observation ? (
          <span className="tool-file-count">{fileCount} items</span>
        ) : (
          <span className="tool-status tool-status--streaming">listing…</span>
        )}
      </span>
    );
  }

  if (t === "codebase_map") {
    const maxDepth = input.max_depth ?? input.depth ?? 5;
    return (
      <span className="tool-flat-head">
        <span className="tool-action">Map</span>
        <span className="tool-icon tool-icon--map">{icons.map}</span>
        <span className="tool-depth">depth: {String(maxDepth)}</span>
        {observation ? (
          <StatusBadge ok={observation.ok} />
        ) : (
          <span className="tool-status tool-status--streaming">mapping…</span>
        )}
      </span>
    );
  }

  const verb = tool.replace(/_/g, " ");
  return (
    <span className="tool-flat-head">
      <span className="tool-action">{verb}</span>
      <span className="tool-icon">{icons.terminal}</span>
      {observation ? (
        <StatusBadge ok={observation.ok} />
      ) : (
        <span className="tool-status tool-status--streaming">working…</span>
      )}
    </span>
  );
}

// Main export - renders appropriate tool output based on type
export function ToolOutput({
  tool,
  input,
  observation,
  streamPreview,
  streamingArgPreview,
  diskSettledOk,
  saveFailed,
  suppressHeader,
  suppressObservationFollowup,
}: ToolOutputProps) {
  const t = tool.toLowerCase();
  
  switch (t) {
    case "read_file":
      return <ReadFileOutput input={input} observation={observation} suppressHeader={suppressHeader} />;
    case "create_file":
      return (
        <CreateFileOutput
          input={input}
          observation={observation}
          streamingArgPreview={streamingArgPreview}
          diskSettledOk={diskSettledOk}
          saveFailed={saveFailed}
          suppressHeader={suppressHeader}
        />
      );
    case "write_patch":
      return (
        <WritePatchOutput
          input={input}
          observation={observation}
          streamingArgPreview={streamingArgPreview}
          diskSettledOk={diskSettledOk}
          suppressHeader={suppressHeader}
          suppressObservationFollowup={suppressObservationFollowup}
        />
      );
    case "run_command":
      return (
        <RunCommandOutput
          input={input}
          observation={observation}
          streamPreview={streamPreview}
          suppressHeader={suppressHeader}
        />
      );
    case "search_code":
      return <SearchCodeOutput input={input} observation={observation} suppressHeader={suppressHeader} />;
    case "semantic_search":
      return <SemanticSearchOutput input={input} observation={observation} suppressHeader={suppressHeader} />;
    case "list_files":
      return <ListFilesOutput input={input} observation={observation} suppressHeader={suppressHeader} />;
    case "codebase_map":
      return <CodebaseMapOutput input={input} observation={observation} suppressHeader={suppressHeader} />;
    default:
      // Fallback for unknown tools
      return (
        <div className="tool-output tool-generic">
          {!suppressHeader && (
          <div className="tool-header">
            <span className="tool-icon">{icons.terminal}</span>
            <span className="tool-action">{tool.replace(/_/g, " ")}</span>
            <span className="tool-target" style={{ flex: 1, minWidth: 0 }} aria-hidden />
            {observation ? (
              <StatusBadge ok={observation.ok} />
            ) : (
              <span className="tool-status tool-status--streaming">working…</span>
            )}
          </div>
          )}
          <pre className="tool-fallback-pre">{JSON.stringify(input, null, 2)}</pre>
          {observation && (
            <pre className="tool-fallback-pre">{observation.summary}</pre>
          )}
        </div>
      );
  }
}

export default ToolOutput;
