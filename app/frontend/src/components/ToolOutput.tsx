import { useState, useEffect, useRef } from "react";
import { FileIcon } from "./FileIcon";
import { ChevronExpand } from "./ChevronExpand";

/**
 * Modern tool output rendering for agent trace steps.
 * Displays tool calls in a clean, Copilot/Cursor-like style.
 */

interface ToolOutputProps {
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
}

// Icons as simple SVG components
const icons = {
  file: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <path d="M13 4H8.414L7.707 3.293A1 1 0 0 0 7 3H3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1z" opacity="0.7"/>
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

// Renders read_file tool output
function ReadFileOutput({ input, observation }: { input: Record<string, unknown>; observation?: ToolOutputProps["observation"] }) {
  const path = String(input.path || "");
  const fileName = path.split("/").pop() || path;
  const [showContent, setShowContent] = useState(false);

  // Extract file content from observation summary
  const content = observation?.summary?.replace(/^read_file .+\n/, "") || "";

  return (
    <div className="tool-output tool-read-file">
      <div className="tool-header">
        <span className="tool-icon">{icons.file}</span>
        <span className="tool-action">Read</span>
        <span className="tool-target">
          <FileIcon name={fileName} size={14} />
          <span className="tool-path" title={path}>{path}</span>
        </span>
        {observation && <StatusBadge ok={observation.ok} />}
      </div>
      {observation && content && (
        <div className="tool-details">
          <button 
            className="tool-toggle"
            onClick={() => setShowContent(!showContent)}
          >
            <ChevronExpand expanded={showContent} size={12} />
            <span>{showContent ? "Hide content" : "Show content"}</span>
          </button>
          {showContent && <CodeBlock content={content} language={guessLanguage(fileName)} />}
        </div>
      )}
    </div>
  );
}

// Renders create_file tool output — with streaming typewriter for content
function CreateFileOutput({
  input,
  observation,
}: {
  input: Record<string, unknown>;
  observation?: ToolOutputProps["observation"];
}) {
  const filePath = String(input.path || "");
  const fileName = filePath.split("/").pop() || filePath;
  const fullContent = String(input.content ?? "");
  const lang = guessLanguage(fileName);

  // Typewriter: stream content char-by-char while observation is pending
  const [displayed, setDisplayed] = useState("");
  const [done, setDone] = useState(false);
  const [showContent, setShowContent] = useState(false);
  const rafRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamRef = useRef<HTMLPreElement>(null);
  const expandRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (observation) {
      setDisplayed(fullContent);
      setDone(true);
      return;
    }
    let pos = 0;
    function tick() {
      pos = Math.min(pos + 4, fullContent.length);
      setDisplayed(fullContent.slice(0, pos));
      // Auto-scroll streaming pre to bottom
      if (streamRef.current) {
        streamRef.current.scrollTop = streamRef.current.scrollHeight;
      }
      if (pos < fullContent.length) {
        rafRef.current = setTimeout(tick, 16);
      } else {
        setDone(true);
      }
    }
    rafRef.current = setTimeout(tick, 16);
    return () => { if (rafRef.current) clearTimeout(rafRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [observation]);

  // Auto-scroll expanded view when user opens it while still streaming
  useEffect(() => {
    if (showContent && expandRef.current) {
      expandRef.current.scrollTop = expandRef.current.scrollHeight;
    }
  }, [displayed, showContent]);

  const isStreaming = !done && !observation;

  return (
    <div className="tool-output tool-create-file">
      <div className="tool-header">
        <span className="tool-icon tool-icon--edit">{icons.edit}</span>
        <span className="tool-action">Create</span>
        <span className="tool-target">
          <FileIcon name={fileName} size={14} />
          <span className="tool-path" title={filePath}>{filePath}</span>
        </span>
        {observation
          ? <StatusBadge ok={observation.ok} />
          : <span className="tool-status tool-status--streaming">writing…</span>
        }
      </div>

      {/* Streaming view: auto-show while still animating */}
      {isStreaming && (
        <div className="tool-create-stream">
          <pre ref={streamRef} className="tool-command-stream tool-create-content">
            <code>{displayed}<span className="tool-cursor">▋</span></code>
          </pre>
        </div>
      )}

      {/* After done: collapsible full content */}
      {done && fullContent && (
        <div className="tool-details">
          <button
            className="tool-toggle"
            onClick={() => setShowContent(!showContent)}
          >
            <ChevronExpand expanded={showContent} size={12} />
            <span>{showContent ? "Hide content" : `Show content (${fullContent.split("\n").length} lines)`}</span>
          </button>
          {showContent && (
            <div className="tool-code-block">
              <pre ref={expandRef} className={`language-${lang}`} style={{ maxHeight: 220, overflow: "auto" }}>
                <code>{fullContent}</code>
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Renders write_patch tool output
function WritePatchOutput({ input, observation }: { input: Record<string, unknown>; observation?: ToolOutputProps["observation"] }) {
  const patches = String(input.patches || input.patch || "");
  const [showDiff, setShowDiff] = useState(false);
  
  // Parse affected files from patches
  const fileMatches = patches.match(/FILE:\s*([^\n]+)/g) || [];
  const files = fileMatches.map(m => m.replace("FILE:", "").trim());
  
  // Parse from observation summary
  const okFiles = observation?.summary?.match(/OK ([^\n]+)/g)?.map(m => m.replace("OK ", "")) || [];
  const failFiles = observation?.summary?.match(/FAIL ([^\n:]+)/g)?.map(m => m.replace("FAIL ", "").split(":")[0]) || [];

  return (
    <div className="tool-output tool-write-patch">
      <div className="tool-header">
        <span className="tool-icon tool-icon--edit">{icons.edit}</span>
        <span className="tool-action">Edit</span>
        <span className="tool-files">
          {(files.length > 0 ? files : [...okFiles, ...failFiles]).slice(0, 3).map((f, i) => (
            <span key={i} className="tool-file-chip">
              <FileIcon name={f.split("/").pop() || ""} size={12} />
              <span>{f.split("/").pop()}</span>
            </span>
          ))}
          {files.length > 3 && <span className="tool-file-more">+{files.length - 3}</span>}
        </span>
        {observation && <StatusBadge ok={observation.ok} />}
      </div>
      {observation && (
        <div className="tool-details">
          <button 
            className="tool-toggle"
            onClick={() => setShowDiff(!showDiff)}
          >
            <ChevronExpand expanded={showDiff} size={12} />
            <span>{showDiff ? "Hide changes" : "Show changes"}</span>
          </button>
          {showDiff && (
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
      )}
    </div>
  );
}

// Renders run_command tool output
function RunCommandOutput({
  input,
  observation,
  streamPreview,
}: {
  input: Record<string, unknown>;
  observation?: ToolOutputProps["observation"];
  streamPreview?: string;
}) {
  const cmd = String(input.cmd || input.command || "");
  const [showOutput, setShowOutput] = useState(false);

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

  const statusLabel = isBackground 
    ? "Running" 
    : exitCode === 0 
      ? "Done" 
      : exitCode !== null 
        ? `Exit ${exitCode}` 
        : undefined;

  return (
    <div className="tool-output tool-run-command">
      <div className="tool-header">
        <span className="tool-icon tool-icon--terminal">{icons.terminal}</span>
        <span className="tool-action">Run</span>
        <code className="tool-cmd" title={cmd}>
          {cmd.length > 60 ? cmd.slice(0, 57) + "…" : cmd}
        </code>
        {observation && (
          <StatusBadge
            ok={observation.ok}
            label={statusLabel}
          />
        )}
      </div>
      {streamPreview && !observation && (
        <div className="tool-command-stream-wrap" aria-live="polite">
          <span className="tool-command-stream-label">Output…</span>
          <pre className="tool-command-stream">{streamPreview}</pre>
        </div>
      )}
      {observation && output && (
        <div className="tool-details">
          <button 
            className="tool-toggle"
            onClick={() => setShowOutput(!showOutput)}
          >
            <ChevronExpand expanded={showOutput} size={12} />
            <span>{showOutput ? "Hide output" : "Show output"}</span>
          </button>
          {showOutput && <CodeBlock content={output} language="shell" maxLines={20} />}
        </div>
      )}
    </div>
  );
}

// Renders search_code tool output
function SearchCodeOutput({ input, observation }: { input: Record<string, unknown>; observation?: ToolOutputProps["observation"] }) {
  const query = String(input.query || "");
  const [showResults, setShowResults] = useState(false);
  
  // Parse hit count from observation
  const hitsMatch = observation?.summary?.match(/\((\d+) hits\)/);
  const hitCount = hitsMatch ? parseInt(hitsMatch[1], 10) : 0;
  
  // Extract search results
  const resultsText = observation?.summary?.replace(/^search_code "[^"]*" \(\d+ hits\):\n/, "") || "";

  return (
    <div className="tool-output tool-search-code">
      <div className="tool-header">
        <span className="tool-icon tool-icon--search">{icons.search}</span>
        <span className="tool-action">Search</span>
        <code className="tool-query">"{query}"</code>
        {observation && (
          <span className="tool-hit-count">{hitCount} matches</span>
        )}
      </div>
      {observation && resultsText && (
        <div className="tool-details">
          <button 
            className="tool-toggle"
            onClick={() => setShowResults(!showResults)}
          >
            <ChevronExpand expanded={showResults} size={12} />
            <span>{showResults ? "Hide results" : "Show results"}</span>
          </button>
          {showResults && <CodeBlock content={resultsText} maxLines={15} />}
        </div>
      )}
    </div>
  );
}

// Renders list_files tool output
function ListFilesOutput({ input, observation }: { input: Record<string, unknown>; observation?: ToolOutputProps["observation"] }) {
  const dir = String(input.dir || ".");
  const [showList, setShowList] = useState(false);
  
  // Parse file count
  const content = observation?.summary?.replace(/^list_files [^\n]+:\n/, "") || "";
  const lines = content.split("\n").filter(Boolean);
  const fileCount = lines.length;

  return (
    <div className="tool-output tool-list-files">
      <div className="tool-header">
        <span className="tool-icon tool-icon--folder">{icons.folder}</span>
        <span className="tool-action">List</span>
        <span className="tool-path" title={dir}>{dir}</span>
        {observation && (
          <span className="tool-file-count">{fileCount} items</span>
        )}
      </div>
      {observation && content && (
        <div className="tool-details">
          <button 
            className="tool-toggle"
            onClick={() => setShowList(!showList)}
          >
            <ChevronExpand expanded={showList} size={12} />
            <span>{showList ? "Hide files" : "Show files"}</span>
          </button>
          {showList && (
            <div className="tool-file-list">
              {lines.slice(0, 30).map((line, i) => {
                const isDir = line.includes("[D]");
                const name = line.replace(/^\s*\[D\]\s*/, "").replace(/^\s+/, "").trim();
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
          )}
        </div>
      )}
    </div>
  );
}

// Renders codebase_map tool output
function CodebaseMapOutput({ input, observation }: { input: Record<string, unknown>; observation?: ToolOutputProps["observation"] }) {
  const maxDepth = input.max_depth || input.depth || 5;
  const [showMap, setShowMap] = useState(false);

  return (
    <div className="tool-output tool-codebase-map">
      <div className="tool-header">
        <span className="tool-icon tool-icon--map">{icons.map}</span>
        <span className="tool-action">Codebase Map</span>
        <span className="tool-depth">depth: {String(maxDepth)}</span>
        {observation && <StatusBadge ok={observation.ok} />}
      </div>
      {observation?.summary && (
        <div className="tool-details">
          <button 
            className="tool-toggle"
            onClick={() => setShowMap(!showMap)}
          >
            <ChevronExpand expanded={showMap} size={12} />
            <span>{showMap ? "Hide map" : "Show map"}</span>
          </button>
          {showMap && <CodeBlock content={observation.summary} maxLines={30} />}
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

// Main export - renders appropriate tool output based on type
export function ToolOutput({ tool, input, observation, streamPreview }: ToolOutputProps) {
  const t = tool.toLowerCase();
  
  switch (t) {
    case "read_file":
      return <ReadFileOutput input={input} observation={observation} />;
    case "create_file":
      return <CreateFileOutput input={input} observation={observation} />;
    case "write_patch":
      return <WritePatchOutput input={input} observation={observation} />;
    case "run_command":
      return <RunCommandOutput input={input} observation={observation} streamPreview={streamPreview} />;
    case "search_code":
      return <SearchCodeOutput input={input} observation={observation} />;
    case "list_files":
      return <ListFilesOutput input={input} observation={observation} />;
    case "codebase_map":
      return <CodebaseMapOutput input={input} observation={observation} />;
    default:
      // Fallback for unknown tools
      return (
        <div className="tool-output tool-generic">
          <div className="tool-header">
            <span className="tool-icon">{icons.terminal}</span>
            <span className="tool-action">{tool.replace(/_/g, " ")}</span>
          </div>
          <pre className="tool-fallback-pre">{JSON.stringify(input, null, 2)}</pre>
          {observation && (
            <pre className="tool-fallback-pre">{observation.summary}</pre>
          )}
        </div>
      );
  }
}

export default ToolOutput;
