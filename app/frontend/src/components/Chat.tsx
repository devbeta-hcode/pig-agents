import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type AgentEvent, type AgentSession, type ChatSessionMeta, type Checkpoint, type SettingsPayload } from "../lib/api";
import { ChatsList } from "./ChatsList";
import { Markdown } from "./Markdown";
import { MentionInput } from "./MentionInput";
import { ChevronExpand } from "./ChevronExpand";
import { DiffViewer, type DiffItem } from "./DiffViewer";
import { FileIcon } from "./FileIcon";
import { CommandApprovalModal, type PendingApproval } from "./CommandApprovalModal";
import { useDialogs } from "./DialogProvider";
import { ToolOutput } from "./ToolOutput";
import {
  IconX, IconCheck, IconCopy, IconRefreshCw, IconRotateCcw,
  IconSettings, IconAlertTriangle, IconSquareFill, IconMessageSquare, IconBot,
} from "./Icons";
import {
  type ChatSession, type ChatTurn, type ChatMode, shortTitle,
  composeAgentTaskWithHistory,
} from "../lib/sessions";

// Key for storing active session ID in sessionStorage (survives F5)
// Keyed by workspace path so multiple tabs with different workspaces don't conflict
function getActiveSessionKey(workspace: string): string {
  // Use a hash of workspace path to avoid special characters in storage key
  const hash = workspace.split('').reduce((a, b) => ((a << 5) - a + b.charCodeAt(0)) | 0, 0).toString(36);
  return `pig-agents.active-session.${hash}`;
}

interface UIEvent extends AgentEvent {
  iteration?: number;
  /** run_command live stream */
  stream?: "stdout" | "stderr";
  text?: string;
  thought?: string;
  tool?: string;
  input?: Record<string, unknown>;
  ok?: boolean;
  summary?: string;
  diffs?: string[];
  result?: string;
  message?: string;
  level?: string;
  delta?: string;
  // Safety-net events:
  checkpoint?: Checkpoint;
  askId?: string;
  cmd?: string;
  suggestedAllow?: string;
  decision?: string;
  matched?: string;
  reason?: string;
}

interface Props {
  session: ChatSession;
  onUpdate: (s: ChatSession) => void;
  onDiffs: (diffs: string[]) => void;
  onAfterRun: () => void;
  refreshKey: number;
  diffs: DiffItem[];
  onUpdateDiff: (id: string, patch: Partial<DiffItem>) => void;
  onClearDiffs: () => void;
  onRemoveDiff?: (id: string) => void;
  onOpenFile: (path: string) => void;
  onOpenDiff?: (item: DiffItem, path: string) => void;
  activeFile?: string;
  modelLabel?: string;
  /** When set, the model pill opens a dropdown to switch `MODEL` without opening full Settings. */
  llmSettings?: SettingsPayload | null;
  onModelChange?: (model: string) => void | Promise<void>;
  onOpenSettings?: () => void;
  onNewChat?: () => void;
  /** When set, a session toolbar + “All chats” browser replace the old sidebar Chats view. */
  chatList?: ChatSessionMeta[];
  onSelectChat?: (id: string) => void;
  onDeleteChat?: (id: string) => void;
  onRenameChat?: (id: string, title: string) => void;
  onExportChats?: () => void;
  onImportChats?: () => void;
  workspace?: string;
  /** When set, append this text to the composer input and focus it. Clear after injecting. */
  pendingInject?: string;
  onInjectConsumed?: () => void;
  /** When set, add this base64 data URL as an attached image thumbnail. */
  pendingInjectImage?: string;
  onInjectImageConsumed?: () => void;
}

// ---------- helpers ----------

function extractMentions(text: string): string[] {
  const out = new Set<string>();
  const re = /(?:^|\s)@([\w./\-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.add(m[1]);
  return [...out];
}

function stripMentions(text: string): string {
  return text.replace(/(?:^|\s)@[\w./\-]+/g, (s) => (s.startsWith("@") ? "" : s[0])).trim();
}

// Remove a single `@path` (and any surrounding whitespace it owns) without
// touching other mentions or the rest of the prompt.
function removeMentionFrom(text: string, path: string): string {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Match the mention with one optional leading space and one optional trailing
  // space so we don't end up with double spaces. Anchored to a word boundary
  // after the path so `@foo` doesn't eat `@foobar`.
  const re = new RegExp(`(^|\\s)@${escaped}(?=$|[^\\w./-])\\s?`, "g");
  return text.replace(re, (_m, lead) => (lead === "" ? "" : lead));
}

/** One-line label for the trace list — Cursor-style verbs + short detail. */
function describeToolStep(tool: string | undefined, input: Record<string, unknown> | undefined): string {
  if (!tool) return "Tool";
  const t = tool.toLowerCase();
  const path = (input?.path ?? input?.file ?? input?.target ?? input?.dir) as string | undefined;
  const q = input?.query as string | undefined;
  const cmd = (input?.cmd ?? input?.command) as string | undefined;
  const short = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
  switch (t) {
    case "codebase_map":
      return "Codebase map";
    case "search_code":
      return q ? `Grepped ${short(q, 72)}` : "Grepped codebase";
    case "read_file":
      return path ? `Read ${short(path, 80)}` : "Read file";
    case "list_files":
      return path ? `Listed ${short(path, 80)}` : "Listed directory";
    case "write_patch":
      return path ? `Edited ${short(path, 80)}` : "Applied patch";
    case "run_command":
      return cmd ? `Ran ${short(cmd, 72)}` : "Ran command";
    default:
      if (path) return `${t.replace(/_/g, " ")} · ${short(path, 64)}`;
      if (cmd) return `${t.replace(/_/g, " ")} · ${short(cmd, 64)}`;
      return t.replace(/_/g, " ");
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) {
    const t = Math.round(s * 10) / 10;
    return `${t % 1 === 0 ? t : t.toFixed(1)}s`;
  }
  const m = Math.floor(s / 60);
  return `${m}m ${Math.floor(s % 60)}s`;
}

/** Last agent thought as a single truncated line (for Cursor-style trace header preview). */
function lastThoughtOneLine(traceSteps: UIEvent[]): string | null {
  let last = "";
  for (const e of traceSteps) {
    if (e.type === "thought" && e.thought?.trim()) last = e.thought.trim();
  }
  if (!last) return null;
  const raw = last.replace(/\s+/g, " ");
  return raw.length > 140 ? `${raw.slice(0, 137)}…` : raw;
}

// ---------- sub-components ----------

function MentionChips({ text }: { text: string }) {
  const mentions = extractMentions(text);
  if (mentions.length === 0) return null;
  return (
    <div className="msg-chips">
      {mentions.map((m) => (
        <span key={m} className="msg-chip" title={m}>
          <span className="chip-icon"><FileIcon name={m.split("/").pop() || ""} size={12} /></span>
          <span className="chip-name">{m.split("/").pop()}</span>
        </span>
      ))}
    </div>
  );
}

function UserMessage({
  task, mode, images, onCopy, onRegenerate, canRegenerate,
}: {
  task: string;
  mode?: ChatMode;
  images?: { id: string; dataUrl: string; name: string }[];
  onCopy: () => void;
  onRegenerate: () => void;
  canRegenerate: boolean;
}) {
  const cleaned = stripMentions(task);
  return (
    <div className="msg msg-user">
      <div className="msg-bubble">
        <MentionChips text={task} />
        {cleaned && <div className="msg-text">{cleaned}</div>}
        {images && images.length > 0 && (
          <div className="msg-images">
            {images.map((img) => (
              <img key={img.id} src={img.dataUrl} alt={img.name} title={img.name} />
            ))}
          </div>
        )}
        {mode && (
          <div className={`msg-mode-badge mode-${mode}`}>
        {mode === "ask" ? <><IconMessageSquare size={13} style={{ marginRight: 4 }} />Ask</> : <><IconBot size={13} style={{ marginRight: 4 }} />Agent</>}
          </div>
        )}
      </div>
      <div className="msg-actions">
        <button onClick={onCopy} title="Copy"><IconCopy size={13} /></button>
        {canRegenerate && (
          <button onClick={onRegenerate} title="Re-run this prompt"><IconRefreshCw size={13} /></button>
        )}
      </div>
    </div>
  );
}

/** Auto-scrolling thought box for streaming content */
function StreamingThoughtBox({ content }: { content: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight;
    }
  }, [content]);
  return (
    <div className="streaming-thought">
      <div className="streaming-thought-content" ref={ref}>
        <Markdown>{content}</Markdown>
        <span className="caret" />
      </div>
    </div>
  );
}

function TraceStep({
  e,
  observation,
  streamPreview,
}: {
  e: UIEvent;
  observation?: UIEvent;
  /** Live stdout/stderr merged from command_chunk events (hidden once observation exists). */
  streamPreview?: string;
}) {
  const [open, setOpen] = useState(false);
  let kind: string | null = null;
  let label = "";
  let body: React.ReactNode = null;
  let useToolOutput = false;

  if (e.type === "thought") {
    kind = "Thinking";
    label = "";
    body = e.thought?.trim()
      ? <div className="trace-md"><Markdown>{e.thought}</Markdown></div>
      : null;
  } else if (e.type === "action") {
    // Use the new ToolOutput component for actions
    useToolOutput = true;
    const obs = observation ? {
      ok: observation.ok ?? false,
      summary: observation.summary ?? "",
      diffs: observation.diffs,
    } : undefined;
    body = (
      <ToolOutput
        tool={e.tool || "unknown"}
        input={e.input || {}}
        observation={obs}
        streamPreview={streamPreview}
      />
    );
  } else if (e.type === "observation") {
    // Standalone observation (shouldn't happen normally, but handle gracefully)
    kind = e.ok ? "Done" : "Failed";
    const summary = e.summary ?? "";
    label = summary.split("\n")[0].slice(0, 100) + (summary.includes("\n") ? "…" : "");
    body = <pre className="trace-pre">{summary}</pre>;
  } else if (e.type === "log") {
    kind = e.level === "error" ? "Error" : e.level === "warn" ? "Warning" : "Info";
    label = String(e.message ?? "");
    body = null;
  } else if (e.type === "policy_decision") {
    if (e.decision === "deny") {
      kind = "Blocked";
      label = (e.cmd ?? "").slice(0, 72) + ((e.cmd ?? "").length > 72 ? "…" : "");
      body = <pre className="trace-pre">{e.reason ?? "blocked"}{e.matched ? `\nmatched: ${e.matched}` : ""}</pre>;
    } else if (e.decision === "allow_always") {
      kind = "Trusted";
      label = (e.cmd ?? "").slice(0, 72) + ((e.cmd ?? "").length > 72 ? "…" : "");
      body = null;
    } else {
      label = String(e.cmd ?? e.type);
    }
  } else {
    label = String(e.message ?? e.type);
  }

  // For ToolOutput, render directly without the standard trace-step wrapper
  if (useToolOutput) {
    return (
      <div className="trace-step trace-action trace-tool-output">
        {body}
      </div>
    );
  }

  const expandable = !!body;

  return (
    <div className={`trace-step trace-${e.type}${open ? " is-open" : ""}`}>
      <button
        type="button"
        className="trace-step-head"
        onClick={() => expandable && setOpen((v) => !v)}
        disabled={!expandable}
        title={expandable ? (open ? "Collapse" : "Expand") : undefined}
      >
        <span className="trace-step-gutter" aria-hidden>
          {expandable ? <ChevronExpand expanded={open} className="trace-chev" size={14} /> : <span className="trace-step-dot" />}
        </span>
        <span className="trace-step-text">
          {kind && <span className="trace-step-kind">{kind}</span>}
          {label ? <span className="trace-label">{label}</span> : null}
        </span>
      </button>
      {expandable && (
        <div className="trace-step-body-shell" aria-hidden={!open}>
          <div className="trace-step-body-inner">
            {body ? <div className="trace-body">{body}</div> : null}
          </div>
        </div>
      )}
    </div>
  );
}

function AssistantMessage({
  turn,
  isStreaming,
  streamingText,
  awaitingStop,
  sessionConnecting,
  onCopy,
  onRegenerate,
  onRetry,
  canRegenerate,
  onRestore,
}: {
  turn: ChatTurn;
  isStreaming: boolean;
  streamingText: string;
  /** User requested stop; stream/backend may still be winding down */
  awaitingStop: boolean;
  /** Waiting for POST /session before SSE attaches */
  sessionConnecting: boolean;
  onCopy: () => void;
  onRegenerate: () => void;
  onRetry: () => void;
  canRegenerate: boolean;
  onRestore: (cp: Checkpoint) => void;
}) {
  const events = turn.events as UIEvent[];
  const finalEv = [...events].reverse().find((e) => e.type === "final");
  const errorEv = [...events].reverse().find((e) => e.type === "error");
  const checkpointEv = events.find((e) => e.type === "checkpoint" && e.checkpoint);
  const checkpoint = checkpointEv?.checkpoint as Checkpoint | undefined;
  const policyDeniedCount = events.filter((e) => e.type === "policy_decision" && e.decision === "deny").length;
  const traceSteps = events.filter(
    (e) =>
      e.type === "thought" ||
      e.type === "action" ||
      e.type === "observation" ||
      e.type === "command_chunk" ||
      (e.type === "log" && !String(e.message || "").startsWith("Parse error:")) ||
      (e.type === "policy_decision" && (e.decision === "deny" || e.decision === "allow_always")),
  );
  // Always start collapsed - user can expand if they want
  const [traceOpen, setTraceOpen] = useState(false);
  const traceListRef = useRef<HTMLDivElement>(null);
  const [, setStreamClock] = useState(0);
  const finalText = finalEv?.result ?? "";
  const errorText = errorEv?.message ?? "";
  const duration = turn.endedAt && turn.startedAt ? formatDuration(turn.endedAt - turn.startedAt) : null;
  const thoughtPreview = lastThoughtOneLine(traceSteps);

  const handleTraceToggle = () => {
    setTraceOpen((v) => !v);
  };

  useEffect(() => {
    if (!isStreaming) return;
    const id = window.setInterval(() => setStreamClock((n) => n + 1), 400);
    return () => clearInterval(id);
  }, [isStreaming]);

  const traceSummary = useMemo(() => {
    if (isStreaming) return null;
    if (duration) return `Thinking · ${duration}`;
    if (traceSteps.length === 0) return null;
    return `${traceSteps.length} step${traceSteps.length === 1 ? "" : "s"}`;
  }, [isStreaming, duration, traceSteps.length]);

  const streamingThinkingTitle =
    isStreaming && turn.startedAt
      ? `Thinking · ${formatDuration(Date.now() - turn.startedAt)}`
      : "Thinking";

  return (
    <div className="msg msg-assistant">
      <div className="msg-content">
        {isStreaming && awaitingStop && (
          <div className="msg-phase-banner msg-phase-banner--stop" role="status" aria-live="polite">
            <span className="composer-spinner" aria-hidden />
            <span>Stopping…</span>
          </div>
        )}
        {isStreaming && !awaitingStop && sessionConnecting && (
          <div className="msg-phase-banner msg-phase-banner--connect" role="status" aria-live="polite">
            <span className="composer-spinner" aria-hidden />
            <span>Connecting…</span>
          </div>
        )}
        {(traceSteps.length > 0 || isStreaming) && (
          <div className={`trace ${traceOpen ? "open" : ""} ${isStreaming ? "trace--streaming" : ""}`}>
            <button
              type="button"
              className={`trace-toggle${thoughtPreview ? " trace-toggle--has-preview" : ""}`}
              onClick={handleTraceToggle}
              title={thoughtPreview && thoughtPreview.length >= 140 ? thoughtPreview : undefined}
            >
              <span className="trace-toggle-gutter" aria-hidden>
                <ChevronExpand expanded={traceOpen} className="trace-toggle-icon" size={14} />
              </span>
              <span className="trace-toggle-main">
                {isStreaming ? (
                  <span className="trace-head-streaming">
                    <span className="thinking-dots" aria-hidden><span /><span /><span /></span>
                    <span className="trace-head-label">{streamingThinkingTitle}</span>
                  </span>
                ) : (
                  <span className="trace-head-label">{traceSummary}</span>
                )}
                {thoughtPreview && (
                  <span className="trace-head-preview">{thoughtPreview}</span>
                )}
              </span>
            </button>
            <div className="trace-list-shell" aria-hidden={!traceOpen}>
              <div className="trace-list-inner">
                <div className="trace-list" ref={traceListRef}>
                  {(() => {
                    // Group action + observation pairs together
                    const rendered: React.ReactNode[] = [];
                    const skipIndices = new Set<number>();

                    traceSteps.forEach((e, i) => {
                      if (skipIndices.has(i)) return;

                      if (e.type === "action") {
                        let j = i + 1;
                        let stream = "";
                        const actIter = e.iteration;
                        while (j < traceSteps.length && traceSteps[j].type === "command_chunk") {
                          const ch = traceSteps[j] as UIEvent;
                          if (actIter !== undefined && ch.iteration !== undefined && ch.iteration !== actIter) break;
                          const t = String(ch.text ?? "");
                          if (t) stream += ch.stream === "stderr" ? `[stderr] ${t}` : t;
                          skipIndices.add(j);
                          j++;
                        }
                        const nextObs = traceSteps[j];
                        if (nextObs?.type === "observation") {
                          skipIndices.add(j);
                          rendered.push(<TraceStep key={i} e={e} observation={nextObs} />);
                        } else {
                          rendered.push(
                            <TraceStep key={i} e={e} streamPreview={stream.trim() ? stream : undefined} />,
                          );
                        }
                      } else if (e.type === "observation") {
                        rendered.push(<TraceStep key={i} e={e} />);
                      } else {
                        rendered.push(<TraceStep key={i} e={e} />);
                      }
                    });

                    return rendered;
                  })()}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Streaming content OUTSIDE trace box - with its own auto-scroll */}
        {isStreaming && !finalText && streamingText && (() => {
          // Extract meaningful content - remove ACTION/JSON parts
          const thoughtMatch = streamingText.match(/THOUGHT:\s*([\s\S]*?)(?=\n\nACTION:|$)/i);
          let displayContent = thoughtMatch?.[1]?.trim() || "";
          
          if (!displayContent) {
            displayContent = streamingText
              .replace(/ACTION:\s*\{[\s\S]*$/i, "")
              .replace(/\{[\s\S]*"type"\s*:\s*"[^"]+"/i, "")
              .trim();
          }
          
          if (!displayContent) return null;
          return <StreamingThoughtBox content={displayContent} />;
        })()}

        {finalText && (
          <div className="msg-text">
            <Markdown>{finalText}</Markdown>
          </div>
        )}

        {errorText && !finalText && (
          <div className="msg-error">
            <div className="msg-error-head">
              <span><IconAlertTriangle size={13} style={{ marginRight: 4 }} />Error</span>
              <button className="msg-error-retry" onClick={onRetry}>Retry</button>
            </div>
            <div className="msg-error-body">{errorText}</div>
          </div>
        )}

        {turn.status === "stopped" && !finalText && (
          <div className="msg-stopped"><IconSquareFill size={10} style={{ marginRight: 6 }} />Stopped by user</div>
        )}

        {!isStreaming && (finalText || errorText || turn.status === "stopped") && (
          <div className="msg-actions msg-actions-bottom">
            {finalText && (
              <button onClick={onCopy} title="Copy answer"><IconCopy size={13} style={{ marginRight: 4 }} />Copy</button>
            )}
            {canRegenerate && (
              <button onClick={onRegenerate} title="Regenerate"><IconRefreshCw size={13} style={{ marginRight: 4 }} />Regenerate</button>
            )}
            {checkpoint && (
              <button
                className="msg-restore"
                onClick={() => onRestore(checkpoint)}
                title={`Restore the workspace to its state before this run (snapshot taken at ${new Date(checkpoint.createdAt).toLocaleTimeString()}).\nA fresh "undo my undo" checkpoint is created first, so this is reversible.`}
              >
                <IconRotateCcw size={13} style={{ marginRight: 4 }} />Restore checkpoint
              </button>
            )}
            {policyDeniedCount > 0 && (
              <span className="msg-meta msg-meta-deny" title="Commands the agent tried to run but were blocked by policy or denied by you">
                {policyDeniedCount} blocked
              </span>
            )}
            {duration && <span className="msg-meta">{duration}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- main ----------

export function Chat({
  session, onUpdate, onDiffs, onAfterRun, refreshKey,
  diffs, onUpdateDiff, onClearDiffs, onRemoveDiff, onOpenFile, onOpenDiff,
  activeFile, modelLabel, llmSettings, onModelChange, onOpenSettings, onNewChat,
  chatList, onSelectChat, onDeleteChat, onRenameChat, onExportChats, onImportChats, workspace,
  pendingInject, onInjectConsumed, pendingInjectImage, onInjectImageConsumed,
}: Props) {
  const dlg = useDialogs();
  const [task, setTask] = useState("");
  // When a context snippet is injected from an external panel (e.g. BrowserPanel "Add to Chat"),
  // append it to whatever the user has already typed and switch to that panel.
  useEffect(() => {
    if (!pendingInject) return;
    setTask((t) => (t ? `${t}\n\n${pendingInject}` : pendingInject));
    onInjectConsumed?.();
  }, [pendingInject]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!pendingInjectImage) return;
    const id = `inject-${Date.now()}`;
    setAttachedImages((prev) => [...prev, { id, dataUrl: pendingInjectImage!, name: "element.png" }]);
    onInjectImageConsumed?.();
  }, [pendingInjectImage]); // eslint-disable-line react-hooks/exhaustive-deps
  const [running, setRunning] = useState(false);
  /** True after Stop/Esc until the run finishes cleanup (SSE close + abort acknowledged). */
  const [awaitingStop, setAwaitingStop] = useState(false);
  const [thinking, setThinking] = useState<{ iteration: number; partial: string } | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  // Attached images (base64 data URLs)
  const [attachedImages, setAttachedImages] = useState<{ id: string; dataUrl: string; name: string }[]>([]);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  // FIFO queue of pending command approvals. We display them one at a time
  // (the first in the queue is the active one) so the user is never asked
  // two questions simultaneously. The runner is blocked on each Promise so
  // there's no race.
  const [approvalQueue, setApprovalQueue] = useState<PendingApproval[]>([]);
  // Track the active backend session ID (for background agent mode)
  // Keyed by workspace so different tabs don't interfere
  const [activeSessionId, setActiveSessionId] = useState<string | null>(() => {
    if (!workspace) return null;
    try { return sessionStorage.getItem(getActiveSessionKey(workspace)); } catch { return null; }
  });
  const logRef = useRef<HTMLDivElement | null>(null);
  const ctrlRef = useRef<{ close: () => void; done: Promise<void> } | null>(null);
  const stoppedRef = useRef(false);
  const sessionRef = useRef(session);
  const reconnectAttemptedRef = useRef(false);

  /** Coalesce SSE token deltas to ~1 UI update per frame so the thread isn’t drowned in setState. */
  const tokenRafRef = useRef<number | null>(null);
  const tokenPendingRef = useRef("");
  const tokenIterRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (sessionRef.current.id !== session.id) sessionRef.current = session;
  }, [session.id]);

  const flushTokenRaf = useCallback(() => {
    tokenRafRef.current = null;
    const add = tokenPendingRef.current;
    if (!add) return;
    tokenPendingRef.current = "";
    const it = tokenIterRef.current;
    setThinking((cur) => ({
      iteration: it ?? cur?.iteration ?? 1,
      partial: (cur?.partial ?? "") + add,
    }));
  }, []);

  const scheduleTokenRaf = useCallback(() => {
    if (tokenRafRef.current != null) return;
    tokenRafRef.current = requestAnimationFrame(flushTokenRaf);
  }, [flushTokenRaf]);

  const cancelTokenRaf = useCallback(() => {
    if (tokenRafRef.current != null) {
      cancelAnimationFrame(tokenRafRef.current);
      tokenRafRef.current = null;
    }
  }, []);

  /** Apply buffered token chars before handling any non-token event (ordering). */
  const flushPendingTokensNow = useCallback(() => {
    cancelTokenRaf();
    const add = tokenPendingRef.current;
    if (!add) return;
    tokenPendingRef.current = "";
    const it = tokenIterRef.current;
    setThinking((cur) => ({
      iteration: it ?? cur?.iteration ?? 1,
      partial: (cur?.partial ?? "") + add,
    }));
  }, [cancelTokenRaf]);

  // ---- Reconnect to running backend session after F5/reload ----
  const processSessionEvent = useCallback((
    ev: UIEvent,
    turnId: string,
  ) => {
    if (ev.type === "token") {
      tokenPendingRef.current += ev.delta ?? "";
      if (ev.iteration != null) tokenIterRef.current = ev.iteration;
      scheduleTokenRaf();
      return;
    }

    flushPendingTokensNow();

    if (ev.type === "iter_start") {
      tokenIterRef.current = ev.iteration ?? 1;
      setThinking({ iteration: ev.iteration ?? 1, partial: "" });
      return;
    }
    if (ev.type === "final" || ev.type === "error" || ev.type === "aborted") {
      setThinking(null);
    }
    if (ev.type === "policy_ask" && ev.askId && ev.cmd) {
      startTransition(() => {
        setApprovalQueue((q) => [
          ...q,
          { askId: ev.askId!, cmd: String(ev.cmd), suggestedAllow: String(ev.suggestedAllow ?? ev.cmd) },
        ]);
      });
    }
    if (ev.type === "done" || ev.type === "run_started") return;

    startTransition(() => {
      patchSession((s) => {
        const turns = s.turns.slice();
        const idx = turns.findIndex((x) => x.id === turnId);
        if (idx === -1) return s;
        turns[idx] = { ...turns[idx], events: [...turns[idx].events, ev] };
        return { ...s, turns, updatedAt: Date.now() };
      });
      if (ev.type === "observation" && ev.diffs && ev.diffs.length) onDiffs(ev.diffs);
    });
  }, [onDiffs, flushPendingTokensNow, scheduleTokenRaf]);

  useEffect(() => {
    if (reconnectAttemptedRef.current) return;
    reconnectAttemptedRef.current = true;
    
    // Helper to connect to a running session
    const connectToSession = (backendSession: { id: string; task: string; mode: "ask" | "agent"; status: string; createdAt: number }) => {
      console.log("[Chat] Reconnecting to running session:", backendSession.id);
      setRunning(true);
      setAutoScroll(true);
      setAwaitingStop(false);
      stoppedRef.current = false;
      
      // Store session ID for future reconnects (keyed by workspace)
      if (workspace) {
        try { sessionStorage.setItem(getActiveSessionKey(workspace), backendSession.id); } catch { /* noop */ }
      }
      setActiveSessionId(backendSession.id);
      
      // Find or create a turn for this session
      const existingTurn = session.turns.find(t => t.status === "running");
      const turnId = existingTurn?.id || `t_reconnect_${Date.now().toString(36)}`;
      
      if (!existingTurn) {
        // Create a placeholder turn for reconnected session
        const reconnectTurn: ChatTurn = {
          id: turnId,
          task: backendSession.task,
          mode: backendSession.mode,
          events: [],
          status: "running",
          startedAt: backendSession.createdAt,
        };
        patchSession((s) => ({
          ...s,
          turns: [...s.turns, reconnectTurn],
          updatedAt: Date.now(),
        }));
      }
      
      // Subscribe to the session stream (will replay events)
      const ctrl = api.streamSession(
        backendSession.id,
        (e) => processSessionEvent(e as UIEvent, turnId),
        (info) => {
          console.log("[Chat] Session info:", info);
          if (info.status !== "running") {
            patchSession((s) => {
              const turns = s.turns.slice();
              const idx = turns.findIndex((x) => x.id === turnId);
              if (idx !== -1) {
                turns[idx] = { ...turns[idx], status: "done", endedAt: Date.now() };
              }
              return { ...s, turns, updatedAt: Date.now() };
            });
            setRunning(false);
            setAwaitingStop(false);
            setThinking(null);
            if (workspace) {
              try { sessionStorage.removeItem(getActiveSessionKey(workspace)); } catch { /* noop */ }
            }
            setActiveSessionId(null);
          }
        },
        (end) => {
          console.log("[Chat] Session ended:", end);
          patchSession((s) => {
            const turns = s.turns.slice();
            const idx = turns.findIndex((x) => x.id === turnId);
            if (idx !== -1) {
              turns[idx] = {
                ...turns[idx],
                status: end.status === "error" ? "error" : "done",
                endedAt: Date.now(),
              };
            }
            return { ...s, turns, updatedAt: Date.now() };
          });
          setRunning(false);
          setAwaitingStop(false);
          setThinking(null);
          if (workspace) {
            try { sessionStorage.removeItem(getActiveSessionKey(workspace)); } catch { /* noop */ }
          }
          setActiveSessionId(null);
          onAfterRun();
        },
      );
      
      ctrlRef.current = ctrl;
      
      ctrl.done.catch((err) => {
        console.error("[Chat] Session stream error:", err);
      }).finally(() => {
        if (ctrlRef.current === ctrl) {
          ctrlRef.current = null;
        }
      });
    };
    
    // Try stored session ID first
    const storedSessionId = activeSessionId;
    if (storedSessionId) {
      api.getSession(storedSessionId).then(({ session: backendSession }) => {
        if (backendSession.status === "running") {
          connectToSession(backendSession);
        } else {
          // Session done, clear and check for other running sessions
          if (workspace) {
            try { sessionStorage.removeItem(getActiveSessionKey(workspace)); } catch { /* noop */ }
          }
          setActiveSessionId(null);
          // Fall through to check running sessions
          return api.getRunningSessions();
        }
      }).then((result) => {
        if (result && result.running && result.running.length > 0) {
          // Found a running session for this workspace
          connectToSession(result.running[0]);
        }
      }).catch((err) => {
        console.warn("[Chat] Failed to check stored session:", err);
        // Try finding any running sessions
        api.getRunningSessions().then(({ running }) => {
          if (running.length > 0) {
            connectToSession(running[0]);
          }
        }).catch(() => { /* no running sessions */ });
      });
    } else {
      // No stored session, check for any running sessions for this workspace
      api.getRunningSessions().then(({ running }) => {
        if (running.length > 0) {
          console.log("[Chat] Found orphaned running session:", running[0].id);
          connectToSession(running[0]);
        }
      }).catch((err) => {
        console.warn("[Chat] Failed to check running sessions:", err);
      });
    }
  }, []); // Run only once on mount

  // ---- Sync running state with backend (handles SSE disconnects, errors) ----
  // Poll every 5 seconds when we think we're running to catch missed events
  useEffect(() => {
    if (!running || !activeSessionId) return;
    
    const checkSessionStatus = async () => {
      try {
        const { session: backendSession } = await api.getSession(activeSessionId);
        if (backendSession.status !== "running") {
          console.log("[Chat] Backend session no longer running, syncing state:", backendSession.status);
          
          // Update turn status
          const lastTurn = sessionRef.current.turns[sessionRef.current.turns.length - 1];
          if (lastTurn?.status === "running") {
            patchSession((s) => {
              const turns = s.turns.slice();
              const idx = turns.findIndex((x) => x.id === lastTurn.id);
              if (idx !== -1) {
                turns[idx] = {
                  ...turns[idx],
                  status: backendSession.status === "error" ? "error" : "done",
                  endedAt: Date.now(),
                  events: backendSession.error 
                    ? [...turns[idx].events, { type: "error", message: backendSession.error } as UIEvent]
                    : turns[idx].events,
                };
              }
              return { ...s, turns, updatedAt: Date.now() };
            });
          }
          
          setRunning(false);
          setAwaitingStop(false);
          setThinking(null);
          if (workspace) {
            try { sessionStorage.removeItem(getActiveSessionKey(workspace)); } catch { /* noop */ }
          }
          setActiveSessionId(null);
          ctrlRef.current?.close();
          ctrlRef.current = null;
        }
      } catch (err) {
        console.warn("[Chat] Failed to check session status:", err);
      }
    };
    
    // Check immediately once
    checkSessionStatus();
    
    // Then check every 5 seconds
    const interval = setInterval(checkSessionStatus, 5000);
    return () => clearInterval(interval);
  }, [running, activeSessionId, workspace]);

  const lastTurn = session.turns[session.turns.length - 1];
  const status = lastTurn?.status ?? "idle";
  const mode: ChatMode = session.mode ?? "agent";

  function setMode(m: ChatMode) {
    if (running) return;
    patchSession((s) => ({ ...s, mode: m, updatedAt: Date.now() }));
  }

  // ---- Editor → Chat bridge (selection popup + Cmd+L / Cmd+K shortcuts) ---
  useEffect(() => {
    interface SelectionDetail {
      path: string;
      startLine: number;
      endLine: number;
      text: string;
      language: string;
    }
    function rangeLabel(d: SelectionDetail) {
      return d.startLine === d.endLine ? `L${d.startLine}` : `L${d.startLine}-${d.endLine}`;
    }
    function onAddToChat(e: Event) {
      const d = (e as CustomEvent<SelectionDetail>).detail;
      const fence = "```";
      const block = `${fence}${d.language}\n// ${d.path}:${rangeLabel(d)}\n${d.text}\n${fence}\n`;
      setTask((t) => {
        const hasMention = t.includes(`@${d.path}`);
        const lead = hasMention ? "" : `@${d.path}\n`;
        const sep = t.length === 0 ? "" : (t.endsWith("\n") ? "" : "\n\n");
        return `${t}${sep}${lead}${block}`;
      });
    }
    function onQuickEdit(e: Event) {
      const d = (e as CustomEvent<SelectionDetail>).detail;
      patchSession((s) => ({ ...s, mode: "agent", updatedAt: Date.now() }));
      const fence = "```";
      setTask(
        `Edit @${d.path} (${rangeLabel(d)}). Replace this snippet with an improved version:\n\n` +
        `${fence}${d.language}\n${d.text}\n${fence}\n\n`,
      );
    }
    window.addEventListener("ba:add-to-chat", onAddToChat);
    window.addEventListener("ba:quick-edit", onQuickEdit);
    return () => {
      window.removeEventListener("ba:add-to-chat", onAddToChat);
      window.removeEventListener("ba:quick-edit", onQuickEdit);
    };
  }, []);

  // Append a path to the composer as an `@mention`. Used by drag-drop.
  function appendMentionPath(p: string) {
    setTask((t) => {
      if (t.includes(`@${p}`)) return t;
      const trimmed = t.replace(/\s+$/, "");
      if (trimmed.length === 0) return `@${p} `;
      return `${trimmed} @${p} `;
    });
  }

  // Auto-scroll only if the user is near the bottom (don't yank away their scroll)
  useEffect(() => {
    if (!autoScroll) return;
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [session.turns, session.turns.map((t) => t.events.length).join(","), thinking?.partial, autoScroll]);

  function onScroll() {
    const el = logRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAutoScroll(distFromBottom < 80);
  }

  function patchSession(fn: (s: ChatSession) => ChatSession) {
    const next = fn(sessionRef.current);
    sessionRef.current = next;
    onUpdate(next);
  }

  const runTask = useCallback(async (t: string) => {
    if (!t.trim() && attachedImages.length === 0) return;
    if (running) return;
    
    // Capture current images before clearing
    const images = attachedImages.slice();
    
    const priorTurns = sessionRef.current.turns.slice();
    const agentTask = composeAgentTaskWithHistory(priorTurns, t);
    const runMode: ChatMode = sessionRef.current.mode ?? "agent";
    const turn: ChatTurn = {
      id: `t_${Date.now().toString(36)}`,
      task: t,
      mode: runMode,
      events: [],
      status: "running",
      startedAt: Date.now(),
      images: images.map((img) => ({ id: img.id, dataUrl: img.dataUrl, name: img.name })),
    };
    patchSession((s) => ({
      ...s,
      title: s.turns.length === 0 ? shortTitle(t) : s.title,
      turns: [...s.turns, turn],
      updatedAt: Date.now(),
    }));
    setTask("");
    setAttachedImages([]); // Clear images after capturing
    setRunning(true);
    setAutoScroll(true);
    setAwaitingStop(false);
    stoppedRef.current = false;
    setThinking({ iteration: 1, partial: "" });

    try {
      // Start a background session - agent continues even if browser disconnects
      // Include images as base64 data
      const { session: backendSession } = await api.startSession(
        agentTask, 
        runMode,
        images.map((img) => ({ dataUrl: img.dataUrl, name: img.name }))
      );
      const sessionId = backendSession.id;
      
      // Store session ID so we can reconnect after F5/reload
      if (workspace) {
        try { sessionStorage.setItem(getActiveSessionKey(workspace), sessionId); } catch { /* noop */ }
      }
      setActiveSessionId(sessionId);
      
      // Subscribe to the session's event stream
      const ctrl = api.streamSession(
        sessionId,
        (e) => processSessionEvent(e as UIEvent, turn.id),
        undefined, // onSessionInfo
        (end) => {
          // Session ended
          patchSession((s) => {
            const turns = s.turns.slice();
            const idx = turns.findIndex((x) => x.id === turn.id);
            if (idx === -1) return s;
            const newStatus = stoppedRef.current ? "stopped" : (end.status === "error" ? "error" : "done");
            turns[idx] = { ...turns[idx], status: newStatus, endedAt: Date.now() };
            return { ...s, turns, updatedAt: Date.now() };
          });
        },
      );
      ctrlRef.current = ctrl;
      await ctrl.done;
      
      // Stream completed (session finished or connection closed)
      patchSession((s) => {
        const turns = s.turns.slice();
        const idx = turns.findIndex((x) => x.id === turn.id);
        if (idx === -1) return s;
        // Only update status if still running (might already be updated by onSessionEnded)
        if (turns[idx].status === "running") {
          const newStatus = stoppedRef.current ? "stopped" : "done";
          turns[idx] = { ...turns[idx], status: newStatus, endedAt: Date.now() };
        }
        return { ...s, turns, updatedAt: Date.now() };
      });
    } catch (err) {
      const msg = (err as Error).message || "";
      const aborted = stoppedRef.current || msg === "aborted" || (err as Error).name === "AbortError";
      patchSession((s) => {
        const turns = s.turns.slice();
        const idx = turns.findIndex((x) => x.id === turn.id);
        if (idx === -1) return s;
        if (aborted) {
          turns[idx] = { ...turns[idx], status: "stopped", endedAt: Date.now() };
        } else {
          const has = turns[idx].events.some((e) => (e as UIEvent).type === "error");
          turns[idx] = {
            ...turns[idx],
            status: "error",
            endedAt: Date.now(),
            events: has ? turns[idx].events : [...turns[idx].events, { type: "error", message: msg } as UIEvent],
          };
        }
        return { ...s, turns, updatedAt: Date.now() };
      });
    } finally {
      setRunning(false);
      setAwaitingStop(false);
      setThinking(null);
      ctrlRef.current = null;
      // Clear stored session ID
      if (workspace) {
        try { sessionStorage.removeItem(getActiveSessionKey(workspace)); } catch { /* noop */ }
      }
      setActiveSessionId(null);
      onAfterRun();
    }
  }, [running, onDiffs, onAfterRun, processSessionEvent]);

  function send() { void runTask(task.trim()); }

  // ---- Image attachment handling ----
  const addImageFromFile = useCallback((file: File) => {
    if (!file.type.startsWith("image/")) return;
    if (file.size > 10 * 1024 * 1024) {
      // 10MB limit
      console.warn("Image too large (max 10MB)");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const id = `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      setAttachedImages((prev) => [...prev, { id, dataUrl, name: file.name }]);
    };
    reader.readAsDataURL(file);
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) addImageFromFile(file);
        return;
      }
    }
  }, [addImageFromFile]);

  const handleImageInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    for (const file of files) {
      addImageFromFile(file);
    }
    // Reset input so same file can be selected again
    e.target.value = "";
  }, [addImageFromFile]);

  const removeImage = useCallback((id: string) => {
    setAttachedImages((prev) => prev.filter((img) => img.id !== id));
  }, []);

  function stop() {
    stoppedRef.current = true;
    setAwaitingStop(true);
    // Close the SSE stream first
    ctrlRef.current?.close();
    // Abort the backend session so agent stops even if we disconnect
    if (activeSessionId) {
      api.abortSession(activeSessionId).catch((err) => {
        console.warn("[Chat] Failed to abort session:", err);
      });
    }
    // Aborting the SSE causes the backend to reject all pending approvals
    // for this run. Drop them from the UI too — the modal would otherwise
    // sit there asking about a command that will never be executed.
    setApprovalQueue([]);
  }

  // Send the user's verdict back to the backend, then pop the queue so the
  // next pending approval (if any) becomes active.
  async function respondToApproval(
    askId: string,
    decision: "allow_once" | "allow_always" | "deny",
    editedCmd?: string,
  ) {
    setApprovalQueue((q) => q.filter((p) => p.askId !== askId));
    try {
      await api.respondApproval(askId, decision, editedCmd);
    } catch (err) {
      // The runner already moved on (timeout, abort, etc.). Nothing actionable.
      console.warn("approval response failed", err);
    }
  }

  // Restore the workspace to a checkpoint. Asks for confirmation since this
  // overwrites the working tree — but emphasises it's reversible because we
  // automatically take a fresh checkpoint of the current state first.
  async function restoreToCheckpoint(cp: Checkpoint) {
    const ok = await dlg.confirm({
      title: "Restore checkpoint",
      message:
        `Restore workspace to "${cp.label}"?\n\n` +
        `This rewinds the entire working tree to the snapshot taken ` +
        `${new Date(cp.createdAt).toLocaleString()}. Untracked files added since ` +
        `then will be removed; ignored files (node_modules etc.) are kept.\n\n` +
        `A fresh "before restore" checkpoint is created first, so this is reversible.`,
      confirmLabel: "Restore",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.restoreCheckpoint(cp.id);
      onAfterRun(); // bump refreshKey so file tree + open editors reload
    } catch (err) {
      void dlg.alert(`Restore failed: ${(err as Error).message}`);
    }
  }

  // Modal "Auto-approve all" button: turn the global flag on (persisted in
  // policy.autoApprove on the backend), then satisfy the current ask with
  // allow_once so the in-flight command runs immediately. The user can flip
  // the flag back off any time from Settings.
  async function autoApproveAllFromModal(askId: string, editedCmd?: string) {
    try {
      await api.setAutoApprove(true);
    } catch (err) {
      void dlg.alert(`Failed to enable auto-approve: ${(err as Error).message}`);
      return;
    }
    void respondToApproval(askId, "allow_once", editedCmd);
  }

  // Drop the last turn (so a re-run replaces it)
  function dropLastTurn() {
    patchSession((s) => ({ ...s, turns: s.turns.slice(0, -1), updatedAt: Date.now() }));
  }

  function regenerate(turn: ChatTurn) {
    if (running) return;
    // Drop turns from this one onward, then re-run the task
    patchSession((s) => {
      const idx = s.turns.findIndex((x) => x.id === turn.id);
      const trimmed = idx === -1 ? s.turns : s.turns.slice(0, idx);
      return { ...s, turns: trimmed, updatedAt: Date.now() };
    });
    void runTask(turn.task);
  }

  function copyText(text: string) {
    navigator.clipboard?.writeText(text).catch(() => { /* ignore */ });
  }

  // Slash commands. Returning `false` keeps the input populated as a prefix
  // (so the user can append text); otherwise we treat the command as instant.
  const slashCommands = useMemo(() => {
    const cmds: { name: string; desc: string; hint?: string }[] = [
      { name: "ask", desc: "Switch to Ask mode (chat-only)", hint: "no edits" },
      { name: "agent", desc: "Switch to Agent mode (autonomous)", hint: "edits + runs" },
      { name: "clear", desc: "Clear all turns in this chat" },
      { name: "new", desc: "Start a fresh chat session" },
    ];
    if (activeFile) {
      cmds.push({ name: "explain", desc: `Explain @${activeFile}`, hint: "active file" });
      cmds.push({ name: "fix", desc: `Find and fix bugs in @${activeFile}` });
      cmds.push({ name: "test", desc: `Write tests for @${activeFile}` });
    }
    return cmds;
  }, [activeFile]);

  function handleSlash(name: string): boolean | void {
    switch (name) {
      case "ask":
        if (!running) patchSession((s) => ({ ...s, mode: "ask", updatedAt: Date.now() }));
        return true;
      case "agent":
        if (!running) patchSession((s) => ({ ...s, mode: "agent", updatedAt: Date.now() }));
        return true;
      case "clear":
        patchSession((s) => ({ ...s, turns: [], updatedAt: Date.now() }));
        return true;
      case "new":
        onNewChat?.();
        return true;
      case "explain":
        if (activeFile) setTask(`Explain what @${activeFile} does and how it fits in the codebase.`);
        return; // leave the seeded text in the input
      case "fix":
        if (activeFile) setTask(`Review @${activeFile} carefully and fix any bugs you find.`);
        return;
      case "test":
        if (activeFile) setTask(`Write unit tests for @${activeFile}.`);
        return;
      default:
        return false;
    }
  }

  // ESC stops the agent while running
  useEffect(() => {
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape" && running) {
        e.preventDefault();
        stop();
      }
    }
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [running]);

  const placeholder = useMemo(() => {
    if (session.turns.length === 0) {
      return mode === "ask"
        ? "Ask anything about the code… use @ to attach files."
        : "Tell the agent what to build, fix, or run… use @ to attach files.";
    }
    return mode === "ask" ? "Ask a follow-up…" : "Continue the task…";
  }, [session.turns.length, mode]);

  const sessionConnecting = running && !activeSessionId && !awaitingStop;

  const statusText =
    running && awaitingStop ? "● stopping…" :
    running && sessionConnecting ? "● connecting…" :
    running ? "● running…" :
    status === "done" ? "● done" :
    status === "error" ? "● error" :
    status === "stopped" ? "● stopped" :
    "● ready";

  const composingMentions = extractMentions(task);

  const [chatsBrowserOpen, setChatsBrowserOpen] = useState(false);

  const showSessionChrome =
    !!workspace &&
    !!chatList &&
    onSelectChat &&
    onDeleteChat &&
    onRenameChat &&
    onExportChats &&
    onImportChats;

  return (
    <div className="chat">
      {showSessionChrome && (
        <div className="chat-session-toolbar">
          <span className="chat-session-heading" title={session.title}>
            {session.title?.trim() || "Chat"}
          </span>
          <div className="chat-session-actions">
            <button
              type="button"
              className="chat-session-history-btn"
              title="Chat history — switch conversation, search, import/export"
              aria-label="Chat history"
              aria-expanded={chatsBrowserOpen}
              aria-haspopup="dialog"
              onClick={() => setChatsBrowserOpen(true)}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
            </button>
            <button
              type="button"
              className="chat-session-icon-btn chat-session-new-btn"
              title="New chat"
              onClick={() => onNewChat?.()}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                <path d="M8 2.5a.5.5 0 0 1 .5.5v4.25H12.5a.5.5 0 0 1 0 1H8.5V12.5a.5.5 0 0 1-1 0V8.5H3.5a.5.5 0 0 1 0-1H7.5V3a.5.5 0 0 1 .5-.5z" />
              </svg>
            </button>
          </div>
        </div>
      )}
      <div className={`chat-status ${running ? "running" : status} ${showSessionChrome ? "chat-status-no-title" : ""}`}>
        {statusText}
        {!showSessionChrome && <span className="chat-status-title">{session.title}</span>}
      </div>

      {showSessionChrome && chatsBrowserOpen && workspace && (
        <div
          className="modal-backdrop chat-browser-backdrop"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setChatsBrowserOpen(false);
          }}
        >
          <div
            className="modal chat-browser-modal"
            role="dialog"
            aria-labelledby="chat-browser-title"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <span id="chat-browser-title">Chat history</span>
              <button
                type="button"
                className="close"
                aria-label="Close"
                onClick={() => setChatsBrowserOpen(false)}
              >
                ×
              </button>
            </div>
            <div className="modal-body chat-browser-body">
              <ChatsList
                sessions={chatList!}
                activeId={session.id}
                workspace={workspace}
                onSelect={(id) => {
                  onSelectChat(id);
                  setChatsBrowserOpen(false);
                }}
                onNew={() => {
                  onNewChat?.();
                  setChatsBrowserOpen(false);
                }}
                onDelete={onDeleteChat}
                onRename={onRenameChat}
                onExport={onExportChats}
                onImport={onImportChats}
              />
            </div>
          </div>
        </div>
      )}

      <div className="chat-log" ref={logRef} onScroll={onScroll}>
        {session.turns.length === 0 && (
          <div className="chat-empty">
            <div className="chat-empty-title">How can I help?</div>
            <div className="chat-empty-sub">
              Ask anything — read code, write features, run tests, fix bugs.
            </div>
            <div className="chat-empty-tips">
              <kbd>Enter</kbd> send · <kbd>Shift+Enter</kbd> newline · <kbd>@</kbd> reference file · <kbd>Esc</kbd> stop
            </div>
          </div>
        )}
        {session.turns.map((turn, ti) => {
          const isLast = ti === session.turns.length - 1;
          const isStreaming = isLast && running;
          return (
            <div key={turn.id} className="chat-turn">
              <UserMessage
                task={turn.task}
                mode={turn.mode}
                images={turn.images}
                onCopy={() => copyText(turn.task)}
                onRegenerate={() => regenerate(turn)}
                canRegenerate={!running}
              />
              <AssistantMessage
                turn={turn}
                isStreaming={isStreaming}
                streamingText={thinking?.partial ?? ""}
                awaitingStop={awaitingStop}
                sessionConnecting={sessionConnecting}
                onCopy={() => {
                  const f = (turn.events as UIEvent[]).slice().reverse().find((e) => e.type === "final");
                  if (f?.result) copyText(f.result);
                }}
                onRegenerate={() => regenerate(turn)}
                onRetry={() => regenerate(turn)}
                canRegenerate={!running && isLast}
                onRestore={restoreToCheckpoint}
              />
            </div>
          );
        })}

        {!autoScroll && (
          <button
            className="scroll-bottom"
            onClick={() => {
              const el = logRef.current;
              if (el) el.scrollTop = el.scrollHeight;
              setAutoScroll(true);
            }}
            title="Scroll to bottom"
          >↓ Latest</button>
        )}
      </div>

      <div
        className={`composer ${dragOver ? "drag-over" : ""} ${diffs.length > 0 ? "has-diffs" : ""}`}
        onDragOver={(e) => {
          const types = e.dataTransfer.types;
          if (types && (Array.from(types).includes("application/x-ba-file") || Array.from(types).includes("application/x-ba-files"))) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            if (!dragOver) setDragOver(true);
          }
        }}
        onDragLeave={(e) => {
          // dragleave fires on children too; only clear when the cursor truly
          // leaves the composer's bounding box.
          const next = e.relatedTarget as Node | null;
          if (!next || !e.currentTarget.contains(next)) setDragOver(false);
        }}
        onDrop={(e) => {
          setDragOver(false);
          const multi = e.dataTransfer.getData("application/x-ba-files");
          if (multi) {
            e.preventDefault();
            for (const p of multi.split("\n").filter(Boolean)) appendMentionPath(p);
            return;
          }
          const single = e.dataTransfer.getData("application/x-ba-file");
          if (single) {
            e.preventDefault();
            appendMentionPath(single);
          }
        }}
      >
        {dragOver && <div className="composer-drop-hint">Drop file to attach as <code>@mention</code></div>}
        <div className="composer-body">
          {diffs.length > 0 && (
            <div className="chat-diffs">
              <DiffViewer
                diffs={diffs}
                onClear={onClearDiffs}
                onUpdate={onUpdateDiff}
                onRemove={onRemoveDiff}
                onOpen={onOpenFile}
                onOpenDiff={onOpenDiff}
              />
            </div>
          )}
          {/* Lower block: textarea + footer toolbar (stacked like Cursor composer). */}
          <div className="composer-lower" onPaste={handlePaste}>
            <div className="composer-input">
              <ComposerHeader
                mentions={composingMentions}
                images={attachedImages}
                running={running}
                awaitingStop={awaitingStop}
                onStop={stop}
                onRemoveMention={(p) => setTask((t) => removeMentionFrom(t, p))}
                onRemoveImage={removeImage}
              />
              <MentionInput
                value={task}
                onChange={setTask}
                onSubmit={send}
                disabled={running}
                placeholder={
                  awaitingStop ? "Stopping…" :
                  running ? "Agent is working…" :
                  placeholder
                }
                refreshKey={refreshKey}
                slashCommands={slashCommands}
                onSlashCommand={handleSlash}
              />
            </div>
            <div className="composer-footer">
              <div className="composer-footer-left">
                <ModeMenu mode={mode} onChange={setMode} disabled={running} />
                {(modelLabel || llmSettings) && (
                  <ComposerModelMenu
                    settings={llmSettings ?? null}
                    currentLabel={modelLabel ?? llmSettings?.MODEL ?? ""}
                    disabled={running}
                    onModelChange={onModelChange}
                    onOpenSettings={onOpenSettings}
                  />
                )}
                {/* Image picker button */}
                <button
                  className="composer-icon-btn image-picker"
                  onClick={() => imageInputRef.current?.click()}
                  disabled={running}
                  title="Attach image (or paste with Ctrl+V)"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                    <circle cx="8.5" cy="8.5" r="1.5"/>
                    <polyline points="21 15 16 10 5 21"/>
                  </svg>
                </button>
                <input
                  ref={imageInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  style={{ display: "none" }}
                  onChange={handleImageInput}
                />
              </div>
              <div className="composer-footer-right">
                {running && (
                  <span
                    className="composer-spinner"
                    title={awaitingStop ? "Stopping…" : sessionConnecting ? "Connecting…" : "Thinking…"}
                  />
                )}
                {lastTurn?.status === "error" && !running && (
                  <button
                    className="composer-icon-btn retry"
                    onClick={() => { dropLastTurn(); void runTask(lastTurn.task); }}
                    title="Retry the last failed prompt"
                  >
                    <IconRefreshCw size={13} />
                  </button>
                )}
                {running ? (
                  <button
                    className="composer-send stop"
                    onClick={stop}
                    title="Stop the agent (Esc)"
                    aria-label="Stop"
                  >
                    <span className="stop-square" />
                  </button>
                ) : (
                  <button
                    className="composer-send"
                    onClick={send}
                    disabled={!task.trim()}
                    title="Send (Enter)"
                    aria-label="Send"
                  >
                    <span className="send-arrow">↑</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <CommandApprovalModal
        pending={approvalQueue[0] ?? null}
        onAnswer={(askId, decision, editedCmd) => void respondToApproval(askId, decision, editedCmd)}
        onAutoApproveAll={(askId, editedCmd) => void autoApproveAllFromModal(askId, editedCmd)}
      />
    </div>
  );
}

// ---- Composer subcomponents ------------------------------------------------

function ComposerHeader({
  mentions, images, running, awaitingStop, onStop, onRemoveMention, onRemoveImage,
}: {
  mentions: string[];
  images: { id: string; dataUrl: string; name: string }[];
  running: boolean;
  awaitingStop: boolean;
  onStop: () => void;
  onRemoveMention: (path: string) => void;
  onRemoveImage: (id: string) => void;
}) {
  // Default to expanded so the user can immediately see + remove individual
  // chips. Auto-collapse only when the count grows large.
  const [expanded, setExpanded] = useState(true);
  const totalCount = mentions.length + images.length;
  if (totalCount === 0 && !running) return null;
  return (
    <div className={`composer-header ${totalCount > 0 && expanded ? "composer-header--attachments-expanded" : ""}`}>
      <div className="composer-header-left">
        {totalCount > 0 && (
          <>
            <button
              className="files-pill"
              onClick={() => setExpanded((v) => !v)}
              title={expanded ? "Collapse attachments" : "Expand attachments"}
            >
              <ChevronExpand expanded={expanded} className="pill-chevron" size={11} />
              <span>{totalCount} {totalCount === 1 ? "File" : "Files"}</span>
            </button>
            <div className="composer-attachments-shell" aria-hidden={!expanded}>
              <div className="composer-attachments-inner">
                <div className="files-pill-list">
                  {mentions.map((m) => (
                    <span key={m} className="msg-chip removable" title={m}>
                      <span className="chip-icon"><FileIcon name={m.split("/").pop() || ""} size={12} /></span>
                      <span className="chip-name">{m.split("/").pop()}</span>
                      <button
                        className="chip-remove"
                        onClick={(e) => { e.stopPropagation(); onRemoveMention(m); }}
                        title={`Remove @${m}`}
                        aria-label={`Remove ${m}`}
                      >
                        <IconX size={12} />
                      </button>
                    </span>
                  ))}
                  {images.map((img) => (
                    <span key={img.id} className="msg-chip removable image-chip" title={img.name}>
                      <span className="chip-icon">
                        <img src={img.dataUrl} alt={img.name} className="chip-thumbnail" />
                      </span>
                      <span className="chip-name">{img.name.length > 12 ? img.name.slice(0, 10) + '…' : img.name}</span>
                      <button
                        className="chip-remove"
                        onClick={(e) => { e.stopPropagation(); onRemoveImage(img.id); }}
                        title="Remove image"
                        aria-label="Remove image"
                      >
                        <IconX size={12} />
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
      <div className="composer-header-right">
        {running && (
          <button
            className="header-stop"
            onClick={onStop}
            disabled={awaitingStop}
            title={awaitingStop ? "Stopping…" : "Stop the agent"}
          >
            {awaitingStop ? "Stopping…" : <>Stop <kbd>Esc</kbd></>}
          </button>
        )}
      </div>
    </div>
  );
}

async function fetchModelListForSettings(s: SettingsPayload): Promise<string[]> {
  try {
    const openAiShaped = ["chatgpt", "gemini", "openroute", "claude", "groq", "local"].includes(s.LLM_PROVIDER);
    if (openAiShaped) {
      const base = s.BASE_URL?.trim() || s.INTEGRATIONS?.[s.LLM_PROVIDER]?.defaultBaseUrl;
      const r = await api.openaiCompatibleModels(base || undefined);
      return r.ok && r.models ? r.models : [];
    }
    if (s.LLM_PROVIDER === "ollama") {
      const r = await api.ollamaModels(s.BASE_URL || undefined);
      return r.ok && r.models ? r.models : [];
    }
    return [];
  } catch {
    return [];
  }
}

function ComposerModelMenu({
  settings,
  currentLabel,
  disabled,
  onModelChange,
  onOpenSettings,
}: {
  settings: SettingsPayload | null;
  currentLabel: string;
  disabled?: boolean;
  onModelChange?: (model: string) => void | Promise<void>;
  onOpenSettings?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const filtered = useMemo(() => {
    if (!search.trim()) return list;
    const q = search.toLowerCase();
    return list.filter((m) => m.toLowerCase().includes(q));
  }, [list, search]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (open && searchRef.current) searchRef.current.focus();
  }, [open]);

  useEffect(() => {
    if (!open || !settings) return;
    let cancelled = false;
    setLoading(true);
    void fetchModelListForSettings(settings).then((m) => {
      if (!cancelled) setList(m);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [open, settings]);

  async function pick(m: string) {
    if (!onModelChange) return;
    await onModelChange(m);
    setOpen(false);
    setSearch("");
  }

  const label = currentLabel || settings?.MODEL || "Model";

  if (!settings) {
    return (
      <button
        type="button"
        className="composer-pill model-pill"
        onClick={() => onOpenSettings?.()}
        title="Open Settings to configure the model"
      >
        <span className="pill-text">{label}</span>
        <ChevronExpand expanded className="pill-chevron" size={11} />
      </button>
    );
  }

  return (
    <div className="mode-menu-wrap model-menu-wrap" ref={ref}>
      <button
        type="button"
        className="composer-pill model-pill"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        title={`Model: ${settings.MODEL} — click to switch`}
      >
        <span className="pill-text">{label}</span>
        <ChevronExpand expanded={open} flipOpen={open} className="pill-chevron" size={11} />
      </button>
      {open && (
        <div className="model-menu" role="listbox" aria-label="Choose model">
          <input
            ref={searchRef}
            type="text"
            className="model-menu-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search models..."
            onKeyDown={(e) => {
              if (e.key === "Enter" && filtered.length === 1) {
                void pick(filtered[0]);
              }
            }}
          />
          <div className="model-menu-list">
            {loading && <div className="model-menu-loading">Loading models…</div>}
            {!loading && list.length === 0 && (
              <div className="model-menu-empty">Could not list models</div>
            )}
            {!loading && list.length > 0 && filtered.length === 0 && (
              <div className="model-menu-empty">No models match "{search}"</div>
            )}
            {filtered.map((m) => (
              <button
                key={m}
                type="button"
                role="option"
                className={`model-menu-item ${m === settings.MODEL ? "active" : ""}`}
                title={m}
                onClick={() => void pick(m)}
              >
                <span className="mm-title model-menu-id">{m}</span>
                {m === settings.MODEL && <span className="mm-check"><IconCheck size={13} /></span>}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="model-menu-footer"
            onClick={() => { setOpen(false); onOpenSettings?.(); }}
          >
            <IconSettings size={13} style={{ marginRight: 4 }} />All LLM settings…
          </button>
        </div>
      )}
    </div>
  );
}

function ModeMenu({
  mode, onChange, disabled,
}: {
  mode: ChatMode;
  onChange: (m: ChatMode) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const icon = mode === "ask" ? <IconMessageSquare size={13} /> : <IconBot size={13} />;
  const label = mode === "ask" ? "Ask" : "Agent";
  return (
    <div className="mode-menu-wrap" ref={ref}>
      <button
        className={`composer-pill mode-pill ${mode}`}
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        title="Change chat mode"
      >
        <span className="pill-icon">{icon}</span>
        <span className="pill-text">{label}</span>
        <ChevronExpand expanded flipOpen={open} className="pill-chevron" size={11} />
      </button>
      {open && (
        <div className="mode-menu" role="menu">
          <button
            role="menuitem"
            className={`mode-menu-item ${mode === "agent" ? "active" : ""}`}
            onClick={() => { onChange("agent"); setOpen(false); }}
          >
            <span className="mm-icon"><IconBot size={15} /></span>
            <span className="mm-body">
              <span className="mm-title">Agent</span>
              <span className="mm-sub">Autonomous: reads, edits, runs commands</span>
            </span>
            {mode === "agent" && <span className="mm-check"><IconCheck size={13} /></span>}
          </button>
          <button
            role="menuitem"
            className={`mode-menu-item ${mode === "ask" ? "active" : ""}`}
            onClick={() => { onChange("ask"); setOpen(false); }}
          >
            <span className="mm-icon"><IconMessageSquare size={15} /></span>
            <span className="mm-body">
              <span className="mm-title">Ask</span>
              <span className="mm-sub">Chat only — replies in markdown, no edits</span>
            </span>
            {mode === "ask" && <span className="mm-check"><IconCheck size={13} /></span>}
          </button>
        </div>
      )}
    </div>
  );
}
