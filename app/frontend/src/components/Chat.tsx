import { startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, type AgentEvent, type AgentSession, type ChatSessionMeta, type Checkpoint, type SettingsPayload } from "../lib/api";
import { ChatsList } from "./ChatsList";
import { Markdown } from "./Markdown";
import { MentionInput } from "./MentionInput";
import { ChevronExpand } from "./ChevronExpand";
import { DiffViewer, type DiffItem } from "./DiffViewer";
import { FileIcon } from "./FileIcon";
import { CommandApprovalModal, type PendingApproval } from "./CommandApprovalModal";
import { useDialogs } from "./DialogProvider";
import { ToolAccordionHeader, ToolOutput } from "./ToolOutput";
import {
  actionMarkerCount,
  mergeWritePatchStreamBody,
  peekStreamingCreatePathNth,
  peekStreamingToolArgBodyNth,
  peekStreamingToolPayloadNth,
  peekWritePatchSectionNth,
  splitWritePatchByFileSections,
} from "../lib/streamingToolPeek";
import {
  IconX, IconCheck, IconCopy, IconRefreshCw, IconRotateCcw,
  IconSettings, IconAlertTriangle, IconSquareFill, IconMessageSquare, IconBot,
  IconBrain,
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
  /** Stable correlation id for tool_disk_settled (write_patch / create_file). */
  actionKey?: string;
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
  /** Wall-clock ms when this event was appended client-side — used to sort after reload. */
  ts?: number;
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

function isWriteToolName(tool?: string): boolean {
  const t = (tool || "").toLowerCase();
  return t === "write_patch" || t === "create_file";
}

/**
 * Ordinal (0-based) of this persisted `action` row within its iteration.
 * Mirrors `nthActionBlobAfterMarker(streamingPartial, ord)` across multiple ACTION payloads in one stream.
 */
function streamedActionOrdinalAtStep(steps: UIEvent[], stepIdx: number): number {
  const ev = steps[stepIdx];
  if (ev?.type !== "action") return 0;
  const it = Number((ev as UIEvent).iteration) || 1;
  let n = 0;
  for (let k = 0; k < stepIdx; k++) {
    const x = steps[k];
    if (x.type === "action" && (Number((x as UIEvent).iteration) || 1) === it) n++;
  }
  return n;
}

function streamedActionCountForIteration(steps: UIEvent[], iteration: number): number {
  return steps.filter(
    (x) => x.type === "action" && (Number((x as UIEvent).iteration) || 1) === iteration,
  ).length;
}

/** Transient action row so ToolOutput can stream before the backend emits complete `action`. */
function syntheticStreamingWriteAction(
  isStreaming: boolean,
  streamingText: string,
  traceSteps: UIEvent[],
  iteration: number,
): UIEvent | null {
  if (!isStreaming || !streamingText.trim()) return null;

  /** More ACTION: markers buffered than SSE `action` rows yet — nth segment is still streaming. */
  const emittedSameIter = traceSteps.filter(
    (x) => x.type === "action" && (Number((x as UIEvent).iteration) || 1) === iteration,
  ).length;
  const nthPeek = emittedSameIter;
  if (actionMarkerCount(streamingText) <= nthPeek) return null;

  const peekMeta = peekStreamingToolPayloadNth(streamingText, nthPeek);
  if (!peekMeta) return null;
  const peekBody = peekStreamingToolArgBodyNth(streamingText, nthPeek);
  const peekPath = peekMeta.tool === "create_file" ? (peekStreamingCreatePathNth(streamingText, nthPeek) ?? "") : "";

  if (peekMeta.tool === "create_file") {
    if (peekBody == null && !peekPath) return null;
    return { type: "action", iteration, tool: "create_file", input: { path: peekPath, content: "" } };
  }
  if (peekBody == null) return null;
  return { type: "action", iteration, tool: "write_patch", input: { patches: "" } };
}

function diskSettledForAction(e: UIEvent, all: UIEvent[]): boolean | undefined {
  if (e.type !== "action") return undefined;
  if (!isWriteToolName(e.tool)) return undefined;
  const iter = e.iteration ?? -1;
  const actionIdx = all.indexOf(e);
  if (actionIdx === -1) return false;
  const settles = all.filter(
    (x) => x.type === "tool_disk_settled" && (x as UIEvent).iteration === iter,
  ) as UIEvent[];
  const key = e.actionKey;
  if (key) {
    const hit = settles.find((x) => (x as UIEvent).actionKey === key);
    if (hit) return (hit as UIEvent).ok !== false;
    return false;
  }
  const priorWrites = all.slice(0, actionIdx + 1).filter(
    (x) =>
      x.type === "action" &&
      (x as UIEvent).iteration === iter &&
      isWriteToolName((x as UIEvent).tool),
  );
  const writeIndex = priorWrites.length - 1;
  const hit = settles[writeIndex];
  if (hit) return (hit as UIEvent).ok !== false;
  return false;
}

/** One combined `observation` often closes all rows at once — collapse earlier write rows as soon as the next ACTION appears. */
function priorWriteCollapsedBySuccessorAction(steps: UIEvent[], actionIdx: number, ev: UIEvent): boolean {
  if (ev.type !== "action") return false;
  if (!isWriteToolName(ev.tool)) return false;
  const it = Number(ev.iteration) || 1;
  if (diskSettledForAction(ev, steps as UIEvent[]) !== true) return false;
  for (let k = actionIdx + 1; k < steps.length; k++) {
    const x = steps[k] as UIEvent;
    if (x.type === "action" && (Number(x.iteration) || 1) === it) return true;
    if (x.type === "observation" && (Number(x.iteration) || 1) === it) return false;
  }
  return false;
}

/** Stable key suffix from `FILE:` line for split write_patch accordion keys. */
function writePatchAccordionSlug(patchSection: string, fi: number): string {
  const m = patchSection.match(/^\s*FILE:\s*(.+?)\s*$/im);
  const raw = (m?.[1] ?? "").trim();
  const leaf = raw.split(/[/\\]/).filter(Boolean).pop() ?? raw;
  return leaf.replace(/\W+/g, "-").slice(0, 56) || `f${fi}`;
}

function streamingThoughtExtract(buf: string): string {
  const thoughtMatch = buf.match(/THOUGHT:\s*([\s\S]*?)(?=\n+ACTION:|\n+FINAL:|$)/i);
  let t = thoughtMatch?.[1]?.trim() || "";
  if (!t) {
    t = buf
      .replace(/\n+ACTION:[\s\S]*$/i, "")
      .replace(/\n+FINAL:[\s\S]*$/i, "")
      .replace(/\{[\s\S]*"type"\s*:\s*"[^"]+"/i, "")
      .trim();
  }
  return t;
}

/** Extract the FINAL: body from a streaming buffer so we can render token-by-token
 *  before the `final` SSE event arrives. Tolerates any trailing garbage. */
function streamingFinalExtract(buf: string): string {
  const m = buf.match(/(?:^|\n)\s*FINAL:\s*([\s\S]*)$/i);
  if (!m) return "";
  // Strip a trailing partial THOUGHT/ACTION header if model started another block (rare).
  return m[1]
    .replace(/\n+(THOUGHT|ACTION)\s*:[\s\S]*$/i, "")
    .trimEnd();
}

function firstObservationAfter(
  steps: UIEvent[],
  startIdx: number,
  iteration: number | undefined,
): { ev: UIEvent; idx: number } | undefined {
  for (let k = startIdx; k < steps.length; k++) {
    const ev = steps[k];
    if (ev.type !== "observation") continue;
    const oi = ev.iteration;
    const ai = iteration;
    if (oi === ai || (oi === undefined && ai === undefined)) return { ev, idx: k };
  }
  return undefined;
}

// ---------- sub-components ----------

function isRedundantUiLog(ev: UIEvent): boolean {
  if (ev.type !== "log") return false;
  const msg = String(ev.message ?? "").trim();
  if (/^(Ask|Agent) mode starting:/.test(msg)) return true;
  if (/^Selected \d+ relevant files\.?$/.test(msg)) return true;
  if (/^Created checkpoint \(/.test(msg)) return true;
  return false;
}

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

function isTraceLogLike(e: UIEvent): boolean {
  if (e.type === "log" && !String(e.message || "").startsWith("Parse error:")) return true;
  if (e.type === "policy_decision" && (e.decision === "deny" || e.decision === "allow_always")) return true;
  return false;
}

/** Renders one compact INF / policy row inside a grouped activity block. */
function TraceLogRow({ e }: { e: UIEvent }) {
  if (e.type === "log") {
    const lvl = e.level === "error" ? "ERR" : e.level === "warn" ? "WRN" : "INF";
    return (
      <div className="trace-log-flat agent-log-line">
        <span className={`trace-log-lvl trace-log-lvl--${e.level || "info"}`}>{lvl}</span>
        <span>{String(e.message ?? "")}</span>
      </div>
    );
  }
  if (e.type === "policy_decision") {
    if (e.decision === "deny") {
      return (
        <div className="trace-log-flat trace-log-flat--deny agent-log-line">
          <span className="trace-log-lvl trace-log-lvl--error">BLK</span>
          <span>{(e.cmd ?? "").slice(0, 120)}{(e.cmd ?? "").length > 120 ? "…" : ""}</span>
        </div>
      );
    }
    if (e.decision === "allow_always") {
      return (
        <div className="trace-log-flat agent-log-line">
          <span className="trace-log-lvl trace-log-lvl--ok">OK</span>
          <span>{(e.cmd ?? "").slice(0, 120)}</span>
        </div>
      );
    }
  }
  return null;
}

function TraceLogGroup({ items }: { items: UIEvent[] }) {
  if (items.length === 0) return null;
  return (
    <div className="agent-log-group" role="log" aria-label="Agent activity">
      {items.map((ev, idx) => (
        <TraceLogRow key={`${idx}-${ev.type}`} e={ev} />
      ))}
    </div>
  );
}



function uiObservationToToolObservation(o?: UIEvent) {
  if (!o || o.type !== "observation") return undefined;
  return {
    ok: o.ok ?? false,
    summary: o.summary ?? "",
    diffs: o.diffs,
  };
}

/** Same peek rules as TraceStep writes — keeps accordion header Applying state accurate. */
function actionStreamingArgPreview(
  ev: UIEvent,
  pairedObservation: UIEvent | undefined,
  streamingPartial: string,
  isStreamingTurn: boolean,
  streamingActionNth: number,
): string | undefined {
  if (ev.type !== "action") return undefined;
  const toolName = (ev.tool || "").toLowerCase();
  const inFlightWrite =
    !pairedObservation &&
    (toolName === "write_patch" || toolName === "create_file") &&
    streamingPartial.trim().length > 0;
  if (!(isStreamingTurn || inFlightWrite)) return undefined;
  if (toolName !== "write_patch" && toolName !== "create_file") return undefined;
  return peekStreamingToolArgBodyNth(streamingPartial, streamingActionNth) ?? undefined;
}

/** Left-border + summary tint cue for filesystem vs mutate vs terminal vs search. */
function toolAccordionAccent(tool?: string): string {
  const x = String(tool || "").toLowerCase();
  if (x === "write_patch" || x === "create_file") return "mutate-fs";
  if (x === "read_file" || x === "list_files") return "read-fs";
  if (x === "run_command") return "terminal";
  if (x === "search_code") return "search";
  if (x === "codebase_map") return "map";
  return "generic";
}

function ActionAccordionFold({
  ev,
  pairedObservation,
  streamingPartial,
  isStreamingTurn,
  allEvents,
  writePatchHeaderPreview,
  streamingActionOrdinal,
  priorWriteCollapsedBySuccessor,
  children,
}: {
  ev: UIEvent;
  pairedObservation?: UIEvent;
  streamingPartial: string;
  isStreamingTurn: boolean;
  allEvents: UIEvent[];
  /** One FILE section when a write_patch accordion is FILE-split — keeps header/teaser from merging all paths. */
  writePatchHeaderPreview?: string;
  /** Which ACTION blob in streamingPartial aligns with `ev` (multi-ACTION SSE turns share one token buffer). */
  streamingActionOrdinal?: number;
  /** Write finished on disk but stream still lists a later ACTION in the same iteration (focus the active row). */
  priorWriteCollapsedBySuccessor?: boolean;
  children: React.ReactNode;
}) {
  if (ev.type !== "action") return <>{children}</>;
  /** Open while APPLYING/RUNNING; collapse once paired observation arrives (minimal Copilot-ish list). */
  const awaitingObservation = pairedObservation?.type !== "observation";
  const supersede = Boolean(priorWriteCollapsedBySuccessor);
  const [foldOpen, setFoldOpen] = useState(() => awaitingObservation && !supersede);
  useEffect(() => {
    if (pairedObservation?.type === "observation") setFoldOpen(false);
  }, [pairedObservation]);
  useEffect(() => {
    if (supersede) setFoldOpen(false);
  }, [supersede]);
  const diskDone = diskSettledForAction(ev, allEvents);
  useEffect(() => {
    if (diskDone === true) setFoldOpen(false);
  }, [diskDone]);
  const streamOrd = streamingActionOrdinal ?? 0;
  const defaultArgPreview = actionStreamingArgPreview(
    ev,
    pairedObservation,
    streamingPartial,
    isStreamingTurn,
    streamOrd,
  );
  const headerStreamingPreview = writePatchHeaderPreview ?? defaultArgPreview;
  const accent = toolAccordionAccent(ev.tool);
  return (
    <details
      className={`assistant-action-fold assistant-action-accent--${accent}`}
      open={foldOpen}
      onToggle={(e) => setFoldOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className="assistant-action-fold-sum tool-header">
        <span className="assistant-action-fold-chev" aria-hidden>
          <ChevronExpand expanded={foldOpen} size={15} />
        </span>
        <ToolAccordionHeader
          tool={ev.tool || "unknown"}
          input={(ev.input || {}) as Record<string, unknown>}
          observation={uiObservationToToolObservation(pairedObservation)}
          streamingArgPreview={headerStreamingPreview}
          diskSettledOk={diskSettledForAction(ev, allEvents)}
        />
      </summary>
      <div className="assistant-action-fold-body">{children}</div>
    </details>
  );
}

/** Drop open whileThought streams; tuck behind summary once tools begin for this iteration. */
function LiveThoughtStreamFold({
  isStreamingAssistant,
  markdown,
  startedAt,
  collapseWhenToolsVisible,
}: {
  isStreamingAssistant: boolean;
  markdown: string;
  startedAt?: number;
  collapseWhenToolsVisible?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const autoOpenedRef = useRef(false);
  /** Default collapsed until first reasoning text lands (respects Cursor-style skim). */
  const [open, setOpen] = useState(false);
  /** Once ACTIONS begin we tuck this fold away — summary must not resemble an active stream (dots + ticking timer). */
  const streamingChrome = Boolean(isStreamingAssistant && !collapseWhenToolsVisible);
  useEffect(() => {
    if (collapseWhenToolsVisible) {
      setOpen(false);
      return;
    }
    if (!streamingChrome || !markdown.trim()) return;
    if (autoOpenedRef.current) return;
    autoOpenedRef.current = true;
    setOpen(true);
  }, [collapseWhenToolsVisible, streamingChrome, markdown]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [markdown, open]);

  const elapsed =
    streamingChrome && startedAt ? formatDuration(Date.now() - startedAt) : null;
  const hasMd = markdown.trim().length > 0;

  const summaryPrimary =
    !streamingChrome
      ? "Thought"
      : hasMd && elapsed
        ? `Thinking · ${elapsed}`
        : hasMd
          ? "Thinking…"
          : elapsed
            ? `Analyzing · ${elapsed}`
            : "Analyzing…";

  return (
    <details
      className="assistant-stream-thought trace-reasoning assistant-thought-box thought-section assistant-live-thought"
      open={open}
      onToggle={(ev) => setOpen((ev.target as HTMLDetailsElement).open)}
    >
      <summary className="trace-reasoning-summary assistant-stream-thought-sum assistant-live-thought-summary">
        <span className="assistant-thought-fold-chev" aria-hidden>
          <ChevronExpand expanded={open} size={15} />
        </span>
        <IconBrain size={13} strokeWidth={1.75} className="assistant-thought-icon" aria-hidden />
        {streamingChrome && !hasMd ? (
          <span className="thinking-dots" aria-hidden><span /><span /><span /></span>
        ) : null}
        <span className="assistant-thought-summary-label">{summaryPrimary}</span>
      </summary>
      <div ref={scrollRef} className="assistant-stream-thought-scroll assistant-thought-content">
        {hasMd ? (
          <div className="assistant-stream-thought-md">
            <Markdown>{markdown}</Markdown>
          </div>
        ) : (
          <div className="assistant-stream-thought-placeholder">Analyzing…</div>
        )}
      </div>
    </details>
  );
}

function ThoughtStepArchive({ e }: { e: UIEvent }) {
  const body = (e.thought || "").trim();
  if (!body) return null;
  return (
    <div className="thought-step-inline trace-md">
      <Markdown>{body}</Markdown>
    </div>
  );
}

function TraceStep({
  e,
  observation,
  streamPreview,
  allEvents,
  streamingPartial,
  isStreamingTurn,
  suppressToolHeader,
  streamingWritePatchArg,
  streamingActionOrdinal,
  suppressWritePatchObservationFollowup,
}: {
  e: UIEvent;
  observation?: UIEvent;
  streamPreview?: string;
  allEvents: UIEvent[];
  streamingPartial: string;
  isStreamingTurn: boolean;
  /** When wrapped in accordion summary, omit duplicate Copilot-style tool row */
  suppressToolHeader?: boolean;
  /**
   * When set (including ""), replaces global peek extraction for write_patch —
   * used when one SSE action is split into one accordion per FILE.
   */
  streamingWritePatchArg?: string;
  /** Streams may contain multiple sequential ACTION payloads; align peek with persisted row order. */
  streamingActionOrdinal?: number;
  suppressWritePatchObservationFollowup?: boolean;
}) {
  if (e.type === "thought") {
    if (!e.thought?.trim()) return null;
    return <ThoughtStepArchive e={e} />;
  }

  if (e.type === "action") {
    const obs = observation
      ? {
          ok: observation.ok ?? false,
          summary: observation.summary ?? "",
          diffs: observation.diffs,
        }
      : undefined;
    const toolName = (e.tool || "").toLowerCase();
    const inFlightWrite =
      !observation &&
      (toolName === "write_patch" || toolName === "create_file") &&
      streamingPartial.trim().length > 0;
    let argPeek: string | undefined;
    if (toolName === "write_patch" && streamingWritePatchArg !== undefined) {
      argPeek = streamingWritePatchArg.trim() ? streamingWritePatchArg : undefined;
    } else if (
      (isStreamingTurn || inFlightWrite) &&
      (toolName === "write_patch" || toolName === "create_file")
    ) {
      argPeek =
        peekStreamingToolArgBodyNth(streamingPartial, streamingActionOrdinal ?? 0) ?? undefined;
    } else {
      argPeek = undefined;
    }
    return (
      <div className="trace-tool-row trace-tool-output">
        <ToolOutput
          tool={e.tool || "unknown"}
          input={e.input || {}}
          observation={obs}
          streamPreview={streamPreview}
          streamingArgPreview={argPeek}
          diskSettledOk={diskSettledForAction(e, allEvents)}
          suppressHeader={suppressToolHeader}
          suppressObservationFollowup={suppressWritePatchObservationFollowup}
        />
      </div>
    );
  }

  if (e.type === "log") {
    return <TraceLogRow e={e} />;
  }

  if (e.type === "policy_decision") {
    return <TraceLogRow e={e} />;
  }

  if (e.type === "observation") {
    const summary = e.summary ?? "";
    return (
      <div className="trace-step trace-step--flat">
        <div className="trace-step-flat-head">{e.ok ? "Done" : "Failed"}</div>
        <pre className="trace-pre trace-obs-pre">{summary}</pre>
      </div>
    );
  }

  if (e.type === "command_chunk") return null;

  return null;
}

function AssistantMessage({
  turn,
  isStreaming,
  streamingText,
  streamingIteration,
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
  streamingIteration?: number;
  awaitingStop: boolean;
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
  const traceSteps = events
    .filter(
      (e) =>
        e.type === "thought" ||
        e.type === "action" ||
        e.type === "observation" ||
        e.type === "command_chunk" ||
        (e.type === "log" &&
          !String(e.message || "").startsWith("Parse error:") &&
        !isRedundantUiLog(e as UIEvent)) ||
      (e.type === "policy_decision" && (e.decision === "deny" || e.decision === "allow_always")),
  )
  .sort((a, b) => {
    const ta = (a as UIEvent).ts ?? 0;
    const tb = (b as UIEvent).ts ?? 0;
    // Only sort when both have timestamps; otherwise preserve insertion order.
    if (!ta || !tb) return 0;
    return ta - tb;
  });
  const currentIter =
    streamingIteration ??
    Math.max(1, ...traceSteps.map((e) => Number((e as UIEvent).iteration) || 0));
  const streamPeekAction = syntheticStreamingWriteAction(
    isStreaming,
    streamingText,
    traceSteps,
    currentIter,
  );

  const turnMode = turn.mode ?? "agent";

  const [streamPulse, setStreamPulse] = useState(0);
  const finalText = finalEv?.result ?? "";
  // While streaming, parse FINAL: out of the live token buffer so the answer
  // appears token-by-token instead of waiting for the SSE `final` event.
  const streamingFinalText = useMemo(
    () => (isStreaming && !finalText ? streamingFinalExtract(streamingText) : ""),
    [isStreaming, streamingText, finalText],
  );
  const displayedFinalText = finalText || streamingFinalText;
  const errorText = errorEv?.message ?? "";
  const duration = turn.endedAt && turn.startedAt ? formatDuration(turn.endedAt - turn.startedAt) : null;
  const streamingThoughtMarkdown = useMemo(
    () => (isStreaming && streamingText.trim() ? streamingThoughtExtract(streamingText) : ""),
    [isStreaming, streamingText],
  );

  const finalizedThoughtIterations = useMemo(() => {
    const set = new Set<number>();
    for (const e of events as UIEvent[]) {
      if (e.type !== "thought") continue;
      if (!(e.thought ?? "").trim()) continue;
      set.add(Number(e.iteration) || 1);
    }
    return set;
  }, [events]);

  const streamThoughtIter = streamingIteration ?? 1;

  useEffect(() => {
    if (!isStreaming) return;
    const id = window.setInterval(() => setStreamPulse((n) => n + 1), 400);
    return () => clearInterval(id);
  }, [isStreaming]);

  void streamPulse;

  const hasAssistantActivity =
    traceSteps.length > 0 || isStreaming || Boolean(streamPeekAction);

  const phaseBanners = (
    <>
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
    </>
  );

  const assistantStepListJsx = !hasAssistantActivity ? null : (
    <div className="assistant-step-list">
      <div className="agent-log-container agent-log-timeline">
      {(() => {
        const rendered: React.ReactNode[] = [];
        const skipIndices = new Set<number>();
        let liveFoldInjected = false;

        const wantLiveThoughtPanel =
          turnMode === "agent" &&
          isStreaming &&
          !finalizedThoughtIterations.has(streamThoughtIter);

        const peekMatchesThoughtIter =
          streamPeekAction != null && Number(streamPeekAction.iteration || 1) === streamThoughtIter;
        const hasActionStepThisThoughtIter = traceSteps.some(
          (ev) =>
            ev.type === "action" &&
            Number((ev as UIEvent).iteration || 1) === streamThoughtIter,
        );
        const thoughtCollapseForTools =
          peekMatchesThoughtIter || hasActionStepThisThoughtIter || streamingFinalText.length > 0;

        function pushLiveThoughtIfNeeded(marker: string) {
          void marker;
          if (liveFoldInjected || !wantLiveThoughtPanel) return;
          rendered.push(
            <LiveThoughtStreamFold
              key={`live-th-${turn.id}-${streamThoughtIter}`}
              isStreamingAssistant={Boolean(isStreaming)}
              markdown={streamingThoughtMarkdown}
              startedAt={turn.startedAt}
              collapseWhenToolsVisible={thoughtCollapseForTools}
            />,
          );
          liveFoldInjected = true;
        }

        traceSteps.forEach((e, i) => {
          if (skipIndices.has(i)) return;
          if (e.type === "command_chunk") return;

          if (e.type === "thought") {
            rendered.push(
              <TraceStep
                key={`th-${Number((e as UIEvent).iteration) || 1}-${i}`}
                e={e as UIEvent}
                allEvents={events as UIEvent[]}
                streamingPartial={streamingText}
                isStreamingTurn={isStreaming}
              />,
            );
            return;
          }

          if (e.type === "action") {
            const ev = e as UIEvent;
            const streamOrd = streamedActionOrdinalAtStep(traceSteps as UIEvent[], i);
            const actIter = Number(ev.iteration) || 1;
            if (!liveFoldInjected && actIter === streamThoughtIter) {
              pushLiveThoughtIfNeeded("before_action");
            }

            let j = i + 1;
            let stream = "";
            while (j < traceSteps.length && traceSteps[j].type === "command_chunk") {
              const ch = traceSteps[j] as UIEvent;
              if (ev.iteration !== undefined && ch.iteration !== undefined && ch.iteration !== ev.iteration) break;
              const t = String(ch.text ?? "");
              if (t) stream += ch.stream === "stderr" ? `[stderr] ${t}` : t;
              skipIndices.add(j);
              j++;
            }
            const paired = firstObservationAfter(traceSteps, j, ev.iteration);
            const hasObservation = paired != null;
            const inp = ev.input ?? {};
            const isWp = (ev.tool || "").toLowerCase() === "write_patch";
            let patchSlices: string[] | null = null;
            if (isWp) {
              const stored = String((inp as Record<string, unknown>).patches ?? (inp as Record<string, unknown>).patch ?? "");
              const merged = mergeWritePatchStreamBody(stored, streamingText, hasObservation, streamOrd);
              const slices = splitWritePatchByFileSections(merged);
              if (slices.length > 1) patchSlices = slices;
            }

            const collapsePriorBecauseSuccessor = priorWriteCollapsedBySuccessorAction(
              traceSteps as UIEvent[],
              i,
              ev,
            );

            const renderBodySingle = (): ReactNode =>
              paired ? (
                <TraceStep
                  key={`ts-${i}`}
                  e={ev}
                  observation={paired.ev}
                  allEvents={events as UIEvent[]}
                  streamingPartial={streamingText}
                  isStreamingTurn={isStreaming}
                  streamingActionOrdinal={streamOrd}
                  suppressToolHeader
                />
              ) : (
                <TraceStep
                  key={`ts-${i}`}
                  e={ev}
                  streamPreview={stream.trim() ? stream : undefined}
                  allEvents={events as UIEvent[]}
                  streamingPartial={streamingText}
                  isStreamingTurn={isStreaming}
                  streamingActionOrdinal={streamOrd}
                  suppressToolHeader
                />
              );

            if (!patchSlices) {
              rendered.push(
                <ActionAccordionFold
                  key={`acc-act-${actIter}-${i}-${ev.tool ?? "tool"}`}
                  ev={ev}
                  pairedObservation={paired?.ev}
                  streamingPartial={streamingText}
                  isStreamingTurn={isStreaming}
                  allEvents={events as UIEvent[]}
                  streamingActionOrdinal={streamOrd}
                  priorWriteCollapsedBySuccessor={collapsePriorBecauseSuccessor}
                >
                  {renderBodySingle()}
                </ActionAccordionFold>,
              );
            } else {
              patchSlices.forEach((slice, fi) => {
                const slug = writePatchAccordionSlug(slice, fi);
                const baseInp = typeof inp === "object" && inp ? (inp as Record<string, unknown>) : {};
                const sliceEv = {
                  ...ev,
                  input: { ...baseInp, patches: slice },
                } as UIEvent;

                const body = paired ? (
                  <TraceStep
                    key={`ts-${i}-wp-${fi}`}
                    e={sliceEv}
                    observation={paired.ev}
                    allEvents={events as UIEvent[]}
                    streamingPartial={streamingText}
                    isStreamingTurn={isStreaming}
                    streamingActionOrdinal={streamOrd}
                    suppressToolHeader
                    suppressWritePatchObservationFollowup={fi !== 0}
                  />
                ) : (
                  <TraceStep
                    key={`ts-${i}-wp-${fi}`}
                    e={sliceEv}
                    streamPreview={fi === 0 && stream.trim() ? stream : undefined}
                    streamingWritePatchArg={peekWritePatchSectionNth(streamingText, streamOrd, fi) ?? ""}
                    allEvents={events as UIEvent[]}
                    streamingPartial={streamingText}
                    isStreamingTurn={isStreaming}
                    streamingActionOrdinal={streamOrd}
                    suppressToolHeader
                    suppressWritePatchObservationFollowup={fi !== 0}
                  />
                );

                rendered.push(
                  <ActionAccordionFold
                    key={`acc-act-${actIter}-${i}-wp-${fi}-${slug}`}
                    ev={sliceEv}
                    pairedObservation={paired?.ev}
                    streamingPartial={streamingText}
                    isStreamingTurn={isStreaming}
                    allEvents={events as UIEvent[]}
                    streamingActionOrdinal={streamOrd}
                    priorWriteCollapsedBySuccessor={collapsePriorBecauseSuccessor}
                    writePatchHeaderPreview={peekWritePatchSectionNth(streamingText, streamOrd, fi) ?? slice}
                  >
                    {body}
                  </ActionAccordionFold>,
                );
              });
            }

            if (paired) skipIndices.add(paired.idx);
            return;
          }

          const ev = e as UIEvent;
          if (isTraceLogLike(ev)) {
            if (i > 0 && isTraceLogLike(traceSteps[i - 1] as UIEvent)) return;
            const group: UIEvent[] = [];
            let j = i;
            while (j < traceSteps.length && !skipIndices.has(j)) {
              const x = traceSteps[j] as UIEvent;
              if (!isTraceLogLike(x)) break;
              group.push(x);
              j++;
            }
            if (group.length > 0) {
              rendered.push(<TraceLogGroup key={`loggrp-${i}`} items={group} />);
            }
            return;
          }

          rendered.push(
            <TraceStep
              key={`misc-${i}`}
              e={ev}
              allEvents={events as UIEvent[]}
              streamingPartial={streamingText}
              isStreamingTurn={isStreaming}
            />,
          );
        });

        if (streamPeekAction) {
          const peekIt = Number(streamPeekAction.iteration) || 1;
          /** Synthetic peek row aligns with buffered ACTION blobs not yet flushed as SSE `action` events. */
          const peekStreamOrd = streamedActionCountForIteration(traceSteps as UIEvent[], peekIt);
          if (!liveFoldInjected && peekIt === streamThoughtIter) {
            pushLiveThoughtIfNeeded("before_peek");
          }
          const peekInRaw = streamPeekAction.input ?? {};
          const basePeekInp =
            typeof peekInRaw === "object" && peekInRaw ? (peekInRaw as Record<string, unknown>) : {};
          const isPeekWp = streamPeekAction.tool?.toLowerCase() === "write_patch";
          let peekSlices: string[] | null = null;
          if (isPeekWp) {
            const storedPeek = String(basePeekInp.patches ?? basePeekInp.patch ?? "");
            const peekMerged = mergeWritePatchStreamBody(storedPeek, streamingText, false, peekStreamOrd);
            const ps = splitWritePatchByFileSections(peekMerged);
            if (ps.length > 1) peekSlices = ps;
          }

          const pushPeekSingle = (): void => {
            rendered.push(
              <ActionAccordionFold
                key={`acc-peek-${streamPeekAction.iteration}-${streamPeekAction.tool}-${String(streamPeekAction.input?.path ?? "patch")}`}
                ev={streamPeekAction}
                pairedObservation={undefined}
                streamingPartial={streamingText}
                isStreamingTurn={isStreaming}
                allEvents={events as UIEvent[]}
                streamingActionOrdinal={peekStreamOrd}
              >
                <TraceStep
                  key="stream-peek-ts"
                  e={streamPeekAction}
                  allEvents={events as UIEvent[]}
                  streamingPartial={streamingText}
                  isStreamingTurn={isStreaming}
                  streamingActionOrdinal={peekStreamOrd}
                  suppressToolHeader
                />
              </ActionAccordionFold>,
            );
          };

          if (!peekSlices) {
            pushPeekSingle();
          } else {
            peekSlices.forEach((slice, fi) => {
              const slug = writePatchAccordionSlug(slice, fi);
              const sliceEv = {
                ...streamPeekAction,
                input: { ...basePeekInp, patches: slice },
              } as UIEvent;
              rendered.push(
                <ActionAccordionFold
                  key={`acc-peek-${streamPeekAction.iteration}-wp-${fi}-${slug}`}
                  ev={sliceEv}
                  pairedObservation={undefined}
                  streamingPartial={streamingText}
                  isStreamingTurn={isStreaming}
                  allEvents={events as UIEvent[]}
                  streamingActionOrdinal={peekStreamOrd}
                  writePatchHeaderPreview={peekWritePatchSectionNth(streamingText, peekStreamOrd, fi) ?? slice}
                >
                  <TraceStep
                    key={`stream-peek-ts-${fi}`}
                    e={sliceEv}
                    streamingWritePatchArg={peekWritePatchSectionNth(streamingText, peekStreamOrd, fi) ?? ""}
                    allEvents={events as UIEvent[]}
                    streamingPartial={streamingText}
                    isStreamingTurn={isStreaming}
                    streamingActionOrdinal={peekStreamOrd}
                    suppressToolHeader
                    suppressWritePatchObservationFollowup={fi !== 0}
                  />
                </ActionAccordionFold>,
              );
            });
          }
        }

        if (!liveFoldInjected && wantLiveThoughtPanel) {
          pushLiveThoughtIfNeeded("eof_tail");
        }

        return rendered;
      })()}
      </div>
    </div>
  );

  return (
    <div className="msg msg-assistant">
      <div className="msg-avatar-row">
        <div className="msg-avatar" aria-hidden>A</div>
        <span className="msg-avatar-label">Pig Agents</span>
      </div>
      <div className="msg-content">
        {phaseBanners}
        {assistantStepListJsx}
        {displayedFinalText && (
          <div className="assistant-answer msg-text">
            <Markdown>{displayedFinalText}</Markdown>
          </div>
        )}

        {errorText && !displayedFinalText && (
          <div className="msg-error">
            <div className="msg-error-head">
              <span><IconAlertTriangle size={13} style={{ marginRight: 4 }} />Error</span>
              <button className="msg-error-retry" onClick={onRetry}>Retry</button>
            </div>
            <div className="msg-error-body">{errorText}</div>
          </div>
        )}

        {turn.status === "stopped" && !displayedFinalText && (
          <div className="msg-stopped"><IconSquareFill size={10} />Stopped by user</div>
        )}

        {!isStreaming && (finalText || errorText || turn.status === "stopped") && (
          <div className="msg-actions msg-actions-bottom">
            {finalText && (
              <button onClick={onCopy} title="Copy answer"><IconCopy size={12} />Copy</button>
            )}
            {canRegenerate && (
              <button onClick={onRegenerate} title="Regenerate"><IconRefreshCw size={12} />Regenerate</button>
            )}
            {checkpoint && (
              <button
                className="msg-restore"
                onClick={() => onRestore(checkpoint)}
                title={`Restore the workspace to its state before this run (snapshot taken at ${new Date(checkpoint.createdAt).toLocaleTimeString()}).\nA fresh "undo my undo" checkpoint is created first, so this is reversible.`}
              >
                <IconRotateCcw size={12} />Restore
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

/** If the user stays within this many px of the chat-log bottom, new tokens keep pinning the tail. */
const CHAT_LOG_STICK_BOTTOM_PX = 140;

export function Chat({
  session, onUpdate, onDiffs, onAfterRun, refreshKey,
  diffs, onUpdateDiff, onClearDiffs, onRemoveDiff, onOpenFile, onOpenDiff,
  activeFile, modelLabel, llmSettings, onModelChange, onOpenSettings, onNewChat,
  chatList, onSelectChat, onDeleteChat, onRenameChat, onExportChats, onImportChats, workspace,
  pendingInject, onInjectConsumed, pendingInjectImage, onInjectImageConsumed,
}: Props) {
  const dlg = useDialogs();
  // taskRef holds the live value — never stale, no re-render on keystroke.
  const taskRef = useRef("");
  // task state: only updated for external changes (inject / clear / slash) so
  // MentionInput can sync its internal textarea via the value prop.
  const [task, setTask] = useState("");
  // Bumped on every external setTask call so MentionInput re-syncs its DOM
  // textarea even when the new string equals the current React state (e.g.
  // clear-after-send: state was already "" because keystrokes don't update it).
  const [taskVersion, setTaskVersion] = useState(0);
  // Derived state that is allowed to cause re-renders — updated only at
  // actual change boundaries so typing mostly avoids re-rendering Chat.
  const [composerMentions, setComposerMentions] = useState<string[]>([]);
  const [taskHasContent, setTaskHasContent] = useState(false);
  const rafRef = useRef<number | null>(null);

  // Stable onChange for MentionInput — does NOT call setTask, so Chat does
  // not re-render on every keystroke. Only updates the two lightweight states.
  const handleComposerChange = useCallback((v: string) => {
    taskRef.current = v;
    // Defer state updates to next animation frame so the DOM input responds
    // immediately and React state catches up after the frame is painted.
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const cur = taskRef.current;
      setComposerMentions(prev => {
        const next = extractMentions(cur);
        return next.join("\0") === prev.join("\0") ? prev : next;
      });
      setTaskHasContent(cur.trim().length > 0);
    });
  }, []);

  // Helper for external updates (inject, clear, slash, drag-drop).
  // Updates both the ref and the sync state so MentionInput gets the new value.
  const setTaskExternal = useCallback((vOrFn: string | ((prev: string) => string)) => {
    const v = typeof vOrFn === "function" ? vOrFn(taskRef.current) : vOrFn;
    taskRef.current = v;
    setTask(v);
    setTaskVersion((n) => n + 1);
    setComposerMentions(extractMentions(v));
    setTaskHasContent(v.trim().length > 0);
  }, []);

  // When a context snippet is injected from an external panel (e.g. BrowserPanel "Add to Chat"),
  // append it to whatever the user has already typed and switch to that panel.
  useEffect(() => {
    if (!pendingInject) return;
    setTaskExternal((t) => (t ? `${t}\n\n${pendingInject}` : pendingInject));
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
  /** Sticky-tail state for "↓ Latest" affordance — ref is authoritative to avoid stale effect reads while streaming replays batches. */
  const [autoScroll, setAutoScroll] = useState(true);
  /** Whether the chat log actually has scrollable overflow — pill only renders when true to avoid the "fake Latest" affordance on short logs. */
  const [hasOverflow, setHasOverflow] = useState(false);
  const stickToBottomRef = useRef(true);
  // scrollTop set by our own auto-snap — used by onScroll to ignore programmatic events.
  const lastProgrammaticTopRef = useRef(0);
  // Last observed scrollTop for user-direction detection (any upward delta exits tail mode).
  const lastScrollTopRef = useRef(0);
  /** Track scrollHeight so a shrink (fold collapse) doesn't masquerade as a user upward scroll. */
  const lastScrollHeightRef = useRef(0);
  /** Once the user explicitly breaks stick (wheel/touch/key), re-engage only when they cuộn sát đáy — not from any "near bottom" sample, otherwise streaming snaps drag them back constantly. */
  const userBrokeStickRef = useRef(false);
  /** Sentinel rendered as the very last child of the chat log. IntersectionObserver watches it: visible = at tail = auto-follow. */
  const bottomSentinelRef = useRef<HTMLDivElement | null>(null);
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

    // Parsed THOUGHT lands after token stream for this iteration ends; wipe the duplicate
    // live buffer so the archived row replaces the expandable stream panel.
    if (ev.type === "thought") {
      setThinking((cur) => {
        if (!cur) return cur;
        const ti = ev.iteration ?? cur.iteration;
        if (cur.iteration !== ti) return cur;
        return { iteration: cur.iteration, partial: "" };
      });
    }

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

    const stamped: UIEvent = ev.ts ? ev : { ...ev, ts: Date.now() };
    startTransition(() => {
      patchSession((s) => {
        const turns = s.turns.slice();
        const idx = turns.findIndex((x) => x.id === turnId);
        if (idx === -1) return s;
        turns[idx] = { ...turns[idx], events: [...turns[idx].events, stamped] };
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
      stickToBottomRef.current = true;
      userBrokeStickRef.current = false;
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
      setTaskExternal((t) => {
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
      setTaskExternal(
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
    setTaskExternal((t) => {
      if (t.includes(`@${p}`)) return t;
      const trimmed = t.replace(/\s+$/, "");
      if (trimmed.length === 0) return `@${p} `;
      return `${trimmed} @${p} `;
    });
  }

  // Snap to bottom helper — records the programmatic scrollTop so the onScroll
  // handler can distinguish our own snap from a real user gesture.
  const snapToBottom = useCallback(() => {
    const el = logRef.current;
    if (!el) return;
    const target = el.scrollHeight - el.clientHeight;
    el.scrollTop = target;
    lastProgrammaticTopRef.current = target;
    lastScrollTopRef.current = target;
  }, []);

  // Auto-scroll only when intentionally following tail — ref avoids React batch lag vs streamed updates.
  useLayoutEffect(() => {
    if (!stickToBottomRef.current) return;
    snapToBottom();
  }, [session.turns, session.turns.map((t) => t.events.length).join(","), thinking?.partial, snapToBottom]);

  // IntersectionObserver on the bottom sentinel is the source of truth for
  // "is the user reading the tail?" — far more robust than scrollTop deltas
  // during streaming (Copilot/Cursor/Claude all use this pattern). When the
  // sentinel leaves view (because the user scrolled up OR new content pushed
  // it below the viewport) we drop tail-follow; when it re-enters we resume.
  useEffect(() => {
    const root = logRef.current;
    const sentinel = bottomSentinelRef.current;
    if (!root || !sentinel) return;
    const io = new IntersectionObserver(
      (entries) => {
        const e = entries[0];
        if (!e) return;
        const overflow = root.scrollHeight > root.clientHeight + 4;
        setHasOverflow((prev) => (prev === overflow ? prev : overflow));
        if (e.isIntersecting) {
          // Sentinel back in view → user is at the tail again. Resume follow.
          if (!stickToBottomRef.current) {
            stickToBottomRef.current = true;
            userBrokeStickRef.current = false;
            setAutoScroll(true);
          }
        } else {
          // Sentinel out of view. Distinguish two causes:
          //  - We are still in stick mode but new content just pushed it down
          //    by 1 frame → snap back, do NOT mark as user break.
          //  - We are not in stick mode (user scrolled up) → mark as broken
          //    so the pill appears.
          if (stickToBottomRef.current) {
            snapToBottom();
          } else if (!userBrokeStickRef.current) {
            userBrokeStickRef.current = true;
            setAutoScroll(false);
          }
        }
      },
      { root, threshold: 0, rootMargin: "0px 0px 32px 0px" },
    );
    io.observe(sentinel);
    // Also keep ResizeObserver to refresh hasOverflow when content height changes.
    const ro = new ResizeObserver(() => {
      const overflow = root.scrollHeight > root.clientHeight + 4;
      setHasOverflow((prev) => (prev === overflow ? prev : overflow));
      if (stickToBottomRef.current) snapToBottom();
    });
    ro.observe(root);
    for (const child of Array.from(root.children)) ro.observe(child);
    return () => {
      io.disconnect();
      ro.disconnect();
    };
  }, [snapToBottom]);

  // Wheel/touch/keyboard listener: any explicit upward gesture immediately
  // breaks stick. This catches the case where the user nudges up by 1-2px,
  // which IntersectionObserver wouldn't fire for (sentinel still visible).
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const breakStick = () => {
      if (!stickToBottomRef.current) return;
      stickToBottomRef.current = false;
      userBrokeStickRef.current = true;
      setAutoScroll(false);
    };
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < -1) breakStick();
    };
    let touchStartY = 0;
    const onTouchStart = (e: TouchEvent) => {
      touchStartY = e.touches[0]?.clientY ?? 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY ?? 0;
      if (y - touchStartY > 4) breakStick();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowUp" || e.key === "PageUp" || e.key === "Home") {
        breakStick();
      }
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    el.addEventListener("keydown", onKeyDown);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  // No onScroll handler needed — IntersectionObserver handles re-engagement.
  // Keep an empty stub so the JSX prop binding stays stable.
  function onScroll() { /* intentionally empty */ }

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
    setTaskExternal("");
    setAttachedImages([]); // Clear images after capturing
    setRunning(true);
    stickToBottomRef.current = true;
    userBrokeStickRef.current = false;
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

  function send() { void runTask(taskRef.current.trim()); }

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
        if (activeFile) setTaskExternal(`Explain what @${activeFile} does and how it fits in the codebase.`);
        return; // leave the seeded text in the input
      case "fix":
        if (activeFile) setTaskExternal(`Review @${activeFile} carefully and fix any bugs you find.`);
        return;
      case "test":
        if (activeFile) setTaskExternal(`Write unit tests for @${activeFile}.`);
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

      <div className="chat-log-wrap">
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
                streamingText={isStreaming ? thinking?.partial ?? "" : ""}
                streamingIteration={isStreaming ? thinking?.iteration : undefined}
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
        <div ref={bottomSentinelRef} className="chat-log-sentinel" aria-hidden />
      </div>

      {!autoScroll && hasOverflow && session.turns.length > 0 && (
        <button
          className="scroll-bottom"
          onClick={() => {
            stickToBottomRef.current = true;
            userBrokeStickRef.current = false;
            snapToBottom();
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
                mentions={composerMentions}
                images={attachedImages}
                running={running}
                awaitingStop={awaitingStop}
                onStop={stop}
                onRemoveMention={(p) => setTaskExternal((t) => removeMentionFrom(t, p))}
                onRemoveImage={removeImage}
              />
              <MentionInput
                value={task}
                valueVersion={taskVersion}
                onChange={handleComposerChange}
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
                    disabled={!taskHasContent}
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
