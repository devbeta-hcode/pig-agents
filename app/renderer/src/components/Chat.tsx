import {
  memo,
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  Children,
  cloneElement,
  isValidElement,
  type ReactNode,
} from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { api, type AgentEvent, type AgentSession, type ChatSessionMeta, type Checkpoint, type SettingsPayload } from "../lib/api";
import { ChatsList } from "./ChatsList";
import { Markdown } from "./Markdown";
import { ComposerEditable } from "./ComposerEditable";
import { MessageBodyWithSelectEls } from "./SelectElChip";
import { ChevronExpand } from "./ChevronExpand";
import { DiffViewer, type DiffItem } from "./DiffViewer";
import { FileIcon } from "./FileIcon";
import { CommandApprovalModal, type PendingApproval } from "./CommandApprovalModal";
import { ContextUsagePanel, ContextUsageTrigger } from "./ContextUsagePanel";
import { TraceActivityRow, TraceLogRow, TracePolicyRow } from "./AgentTraceRows";
import { deriveLiveActivity } from "../lib/agentActivity";
import { actionScheduleKey, dedupeTraceTimelineEvents } from "../lib/actionScheduleKey";
import { observationLooksCombined, sliceObservationForAction } from "../lib/observationPairing";
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
  type ChatSession, type ChatTurn, type ChatMode, type ChatSelectElMeta, shortTitle,
  composeAgentTaskWithHistory,
} from "../lib/sessions";
import {
  BROWSER_ELEMENT_PICK_EVENT,
  expandSelectElsForAgent,
  extractSelectElKeys,
  formatSelectElToken,
  selectElKeyFromIndex,
  stripSelectElTokens,
  tagLabelFromPath,
  type BrowserElementPickDetail,
  type BrowserElementRef,
} from "../lib/browserElementRefs.js";
import { fetchContextPreview, contextUsageFromEvent, type ContextUsage } from "../lib/contextEstimate";

function buildSelectElMeta(
  text: string,
  refs: ReadonlyMap<string, BrowserElementRef>,
): ChatSelectElMeta[] {
  return extractSelectElKeys(text).map((key) => {
    const ref = refs.get(key);
    return {
      key,
      tagLabel: ref?.tagLabel ?? tagLabelFromPath(ref?.path ?? ""),
      screenshotDataUrl: ref?.screenshotDataUrl,
      path: ref?.path,
      url: ref?.url,
      attributes: ref?.attributes,
      textContent: ref?.textContent,
      rect: ref?.rect,
      computedStyles: ref?.computedStyles,
    };
  });
}
// Key for storing active session ID in sessionStorage (survives F5)
// Keyed by workspace path so multiple tabs with different workspaces don't conflict
function getActiveSessionKey(workspace: string): string {
  // Use a hash of workspace path to avoid special characters in storage key
  const hash = workspace.split('').reduce((a, b) => ((a << 5) - a + b.charCodeAt(0)) | 0, 0).toString(36);
  return `pig-agents.active-session.${hash}`;
}

interface UIEvent extends AgentEvent {
  phase?: string;
  label?: string;
  iteration?: number;
  /** Stable correlation id for tool_disk_settled (write_patch / create_file). */
  actionKey?: string;
  /** run_command live stream */
  stream?: "stdout" | "stderr";
  text?: string;
  reasoning?: string;
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
  /** How long the model spent on this iteration's THOUGHT phase (client-measured). */
  thoughtMs?: number;
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

function collectSelectElImages(
  text: string,
  refs: ReadonlyMap<string, BrowserElementRef>,
): { id: string; dataUrl: string; name: string }[] {
  return extractSelectElKeys(text).flatMap((key) => {
    const ref = refs.get(key);
    if (!ref?.screenshotDataUrl) return [];
    return [{ id: `sel-${key}`, dataUrl: ref.screenshotDataUrl, name: key }];
  });
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

/** Settled or persisted duration for a thought iteration (ms). */
function thoughtDurationMsForIter(
  events: UIEvent[],
  iter: number,
  settledMap?: Map<number, number>,
): number | undefined {
  for (const e of events) {
    if (e.type !== "thought" || Number(e.iteration) !== iter) continue;
    if (e.thoughtMs != null) return e.thoughtMs;
  }
  const settled = settledMap?.get(iter);
  if (settled != null) return settled;
  const iterStart = events.find((e) => e.type === "iter_start" && Number(e.iteration) === iter);
  const endEv =
    [...events].reverse().find((e) => e.type === "thought" && Number(e.iteration) === iter)
    ?? events.find((e) => e.type === "action" && Number(e.iteration) === iter);
  if (iterStart?.ts && endEv?.ts) return Math.max(0, endEv.ts - iterStart.ts);
  return undefined;
}

function isWriteToolName(tool?: string): boolean {
  const t = (tool || "").toLowerCase();
  return t === "write_patch" || t === "create_file";
}

function writeActionCountForIteration(steps: UIEvent[], iteration: number): number {
  return steps.filter(
    (x) =>
      x.type === "action" &&
      (Number((x as UIEvent).iteration) || 1) === iteration &&
      isWriteToolName((x as UIEvent).tool),
  ).length;
}

/** True when peek key matches an already-emitted write action (incl. pending → resolved FILE list). */
function writePeekMatchesEmittedAction(
  steps: UIEvent[],
  iteration: number,
  peekKey: string,
): boolean {
  return steps.some((x) => {
    if (x.type !== "action" || (Number((x as UIEvent).iteration) || 1) !== iteration) return false;
    if (!isWriteToolName((x as UIEvent).tool)) return false;
    const ak = String((x as UIEvent).actionKey ?? "").trim();
    if (ak && ak === peekKey) return true;
    const xKey = actionScheduleKey(
      String((x as UIEvent).tool ?? ""),
      ((x as UIEvent).input ?? {}) as Record<string, unknown>,
    );
    if (xKey === peekKey) return true;
    if (xKey === "write_patch:__pending__" && peekKey.startsWith("write_patch:") && peekKey !== xKey) {
      return true;
    }
    if (peekKey === "write_patch:__pending__" && xKey.startsWith("write_patch:")) return true;
    return false;
  });
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
  if (!isStreaming) return null;

  const writeEmitted = writeActionCountForIteration(traceSteps, iteration);

  /** Native OpenAI tool stream: backend emits tool_payload_streaming before JSON args finish. */
  const nativePayload = [...traceSteps]
    .reverse()
    .find(
      (x) =>
        x.type === "tool_payload_streaming" &&
        (Number((x as UIEvent).iteration) || 1) === iteration,
    ) as UIEvent | undefined;
  if (nativePayload?.tool && writeEmitted === 0) {
    const tool = String(nativePayload.tool).toLowerCase();
    if (tool === "create_file") {
      return { type: "action", iteration, tool: "create_file", input: { path: "", content: "" } };
    }
    if (tool === "write_patch") {
      return { type: "action", iteration, tool: "write_patch", input: { patches: "" } };
    }
  }

  if (!streamingText.trim()) return null;

  /** More ACTION: markers buffered than settled write `action` rows — nth segment still streaming. */
  const nthPeek = writeEmitted;
  if (actionMarkerCount(streamingText) <= nthPeek) return null;

  const peekMeta = peekStreamingToolPayloadNth(streamingText, nthPeek);
  if (!peekMeta) return null;
  const peekBody = peekStreamingToolArgBodyNth(streamingText, nthPeek);
  const peekPath = peekMeta.tool === "create_file" ? (peekStreamingCreatePathNth(streamingText, nthPeek) ?? "") : "";

  if (peekMeta.tool === "create_file") {
    if (peekBody == null && !peekPath) return null;
    const peekKey = actionScheduleKey("create_file", { path: peekPath });
    if (writePeekMatchesEmittedAction(traceSteps, iteration, peekKey)) return null;
    return { type: "action", iteration, tool: "create_file", input: { path: peekPath, content: "" } };
  }
  if (peekBody == null) return null;
  const peekKey = actionScheduleKey("write_patch", { patches: peekBody });
  if (writePeekMatchesEmittedAction(traceSteps, iteration, peekKey)) return null;
  return { type: "action", iteration, tool: "write_patch", input: { patches: "" } };
}

/** Match observation to a streaming peek row (synthetic action not in the event list). */
function observationForStreamingPeek(peek: UIEvent, events: UIEvent[]): UIEvent | undefined {
  const it = Number(peek.iteration) || 1;
  const path = String((peek.input as Record<string, unknown>)?.path ?? "").trim();
  for (const e of events) {
    if (e.type !== "observation" || Number(e.iteration) !== it) continue;
    const sum = String(e.summary ?? "");
    const diffs = e.diffs;
    if (!path) return e;
    if (sum.includes(path) || (Array.isArray(diffs) && diffs.some((d) => String(d).includes(path)))) {
      return e;
    }
  }
  const any = events.find((e) => e.type === "observation" && Number(e.iteration) === it);
  return any;
}

function diskSettledForAction(e: UIEvent, all: UIEvent[]): boolean | undefined {
  if (e.type !== "action") return undefined;
  if (!isWriteToolName(e.tool)) return undefined;
  const iter = e.iteration ?? -1;
  const actionIdx = all.indexOf(e);
  if (actionIdx === -1) {
    const settles = all.filter(
      (x) => x.type === "tool_disk_settled" && (x as UIEvent).iteration === iter,
    ) as UIEvent[];
    if (settles.length === 0) return undefined;
    return settles[settles.length - 1].ok !== false;
  }
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

/** Unique key per ACTION row — prevents merging into "Edit N files" groups. */
function actionGroupKey(tool: string, iteration: number, suffix: string): string {
  return `${(tool || "tool").toLowerCase()}#${iteration}#${suffix}`;
}

/** Merge pre-THOUGHT reasoning with THOUGHT body for a single UI fold. */
function mergeThoughtBody(reasoning: string, thought: string): string {
  const r = reasoning.trim();
  const t = thought.trim();
  if (r && t) return `${r}\n\n${t}`;
  return t || r;
}

/** Drop a complete leading `{"type":...}` / `{"patches":...}` blob (not shown in Thought UI). */
function stripLeadingBareToolJson(buf: string): string {
  const t = buf.trimStart();
  if (!t.startsWith("{")) return buf;
  const head = t.slice(0, 96);
  if (!/^\{\s*"(?:type|patches)"\s*:/.test(head)) return buf;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (c === "\\" && inStr) {
      esc = true;
      continue;
    }
    if (c === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (c === "{") depth++;
    if (c === "}") {
      depth--;
      if (depth === 0) return buf.slice(buf.length - t.length + i + 1).trimStart();
    }
  }
  // Incomplete tool JSON still streaming — hide it from reasoning until THOUGHT/ACTION.
  const cut = t.match(/\bTHOUGHT\s*:|\bACTION\s*:|\bFINAL\s*:/i);
  if (cut?.index != null && cut.index > 0) return buf.slice(buf.length - t.length + cut.index).trimStart();
  return "";
}

/** Content BEFORE THOUGHT: — the raw reasoning trace shown in the streaming box. */
function streamingReasoningExtract(buf: string): string {
  let norm = normalizeStreamXmlMarkers(buf);
  norm = stripLeadingBareToolJson(norm);
  // Reasoning is ONLY the prefix before THOUGHT/ACTION/FINAL — never tool JSON.
  const m = norm.match(
    /^[\s\S]*?(?=\bTHOUGHT\s*:|\bACTION\s*:|\bFINAL\s*:|\{[\s\S]{0,40}"(?:type|patches)"\s*:|$)/i,
  );
  return (m?.[0] ?? "").trim();
}

/** Content AFTER THOUGHT: — shown as plain text log once THOUGHT: appears. */
function streamingThoughtExtract(buf: string): string {
  const norm = normalizeStreamXmlMarkers(buf);
  const m = norm.match(
    /\bTHOUGHT\s*:\s*([\s\S]*?)(?=\bACTION\s*:|\bFINAL\s*:|\{[\s\S]{0,40}"(?:type|patches)"\s*:|$)/i,
  );
  if (!m) return "";
  return m[1]
    .replace(/\bACTION\s*:[\s\S]*$/i, "")
    .replace(/\bFINAL\s*:[\s\S]*$/i, "")
    .trim();
}

/** Hard cap on the in-flight streaming buffer for a single iteration. Without
 *  this a multi-MB tool payload (huge `create_file` body) keeps the entire
 *  string in React state every animation frame, which O(n) re-allocates and
 *  starves the tab's heap. The cap is large enough that the live preview
 *  (peek + thought extract) still gets the latest text; older bytes stayed
 *  irrelevant for what's visible. */
const STREAMING_BUFFER_CAP = 256_000; // ~256 KB
function capStreamingBuffer(s: string): string {
  if (s.length <= STREAMING_BUFFER_CAP) return s;
  return s.slice(s.length - STREAMING_BUFFER_CAP);
}

/** Extract the FINAL: body from a streaming buffer so we can render token-by-token
 *  before the `final` SSE event arrives. Tolerates any trailing garbage. */
function streamingFinalExtract(buf: string): string {
  const m = normalizeStreamXmlMarkers(buf).match(/(?:^|\n)\s*FINAL:\s*([\s\S]*)$/i);
  if (!m) return "";
  // Strip a trailing partial THOUGHT/ACTION header if model started another block (rare).
  return m[1]
    .replace(/\n+(THOUGHT|ACTION)\s*:[\s\S]*$/i, "")
    .trimEnd();
}

/** Mirror of backend stream normalizers so THOUGHT/ACTION render while tokens arrive. */
function normalizeStreamXmlMarkers(buf: string): string {
  let out = buf.replace(/\r\n/g, "\n");
  out = out.replace(/(\})\s*(THOUGHT|ACTION|FINAL):/gi, "$1\n$2:");
  out = out.replace(/(<\/\|DSML\|invoke>)\s*(THOUGHT|ACTION|FINAL):/gi, "$1\n$2:");
  out = out.replace(/END"\s*\}\s*(THOUGHT|ACTION|FINAL):/gi, 'END"}\n$1:');
  out = out.replace(/<\s*thought\s*>\s*/gi, "\nTHOUGHT: ");
  out = out.replace(/<\s*\/\s*thought\s*>\s*/gi, "\n");
  out = out.replace(/<\s*action\s*>\s*/gi, "\nACTION: ");
  out = out.replace(/<\s*\/\s*action\s*>\s*/gi, "\n");
  out = out.replace(/<\s*final\s*>\s*/gi, "\nFINAL: ");
  out = out.replace(/<\s*\/\s*final\s*>\s*/gi, "\n");
  return out;
}

function traceIterationMatch(obsIter: number | undefined, actionIter: number | undefined): boolean {
  return obsIter === actionIter || (obsIter === undefined && actionIter === undefined);
}

function firstObservationAfter(
  steps: UIEvent[],
  startIdx: number,
  iteration: number | undefined,
  action?: { actionKey?: string; tool?: string; input?: Record<string, unknown> },
): { ev: UIEvent; idx: number; combined?: boolean } | undefined {
  const { actionKey, tool, input } = action ?? {};
  if (actionKey) {
    for (let k = startIdx; k < steps.length; k++) {
      const ev = steps[k];
      if (ev.type !== "observation" || ev.actionKey !== actionKey) continue;
      if (!traceIterationMatch(ev.iteration, iteration)) continue;
      return { ev, idx: k };
    }
  }
  for (let k = startIdx; k < steps.length; k++) {
    const ev = steps[k];
    if (ev.type !== "observation") continue;
    if (!traceIterationMatch(ev.iteration, iteration)) continue;
    if (ev.actionKey) continue;
    if (ev.tool && tool && ev.tool !== tool) continue;
    const combined = observationLooksCombined(ev.summary ?? "");
    return { ev: sliceObservationForAction(ev, tool, input) as UIEvent, idx: k, combined };
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

function UserMessageBase({
  task, selectElMeta, mode, images, onCopy, onRegenerate, canRegenerate,
}: {
  task: string;
  selectElMeta?: ChatSelectElMeta[];
  mode?: ChatMode;
  images?: { id: string; dataUrl: string; name: string }[];
  onCopy: () => void;
  onRegenerate: () => void;
  canRegenerate: boolean;
}) {
  const displayText = stripMentions(task);
  const visibleImages = images?.filter((img) => !img.name.startsWith("select el "));
  const hasInline =
    displayText.trim().length > 0 || extractSelectElKeys(task).length > 0;
  return (
    <div className="msg msg-user">
      <div className="msg-bubble">
        <MentionChips text={task} />
        {hasInline && (
          <div className="msg-text msg-text--with-chips">
            <MessageBodyWithSelectEls text={displayText} selectElMeta={selectElMeta} />
          </div>
        )}
        {visibleImages && visibleImages.length > 0 && (
          <div className="msg-images">
            {visibleImages.map((img) => (
              <img key={img.id} src={img.dataUrl} alt={img.name} title={img.name} />
            ))}
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

// Memoized — older user turns are immutable; ignore callback identity so
// inline lambdas in the parent's `.map(...)` don't force re-renders.
const UserMessage = memo(UserMessageBase, (a, b) =>
  a.task === b.task &&
  a.selectElMeta === b.selectElMeta &&
  a.mode === b.mode &&
  a.images === b.images &&
  a.canRegenerate === b.canRegenerate,
);

function thoughtCollapsedPreview(raw: string, maxChars = 100): string {
  const flat = raw
    .replace(/\r\n/g, "\n")
    .trim()
    .replace(/\n+/g, " ")
    .replace(/\*{1,2}/g, "");
  if (flat.length <= maxChars) return flat;
  return `${flat.slice(0, maxChars - 1)}…`;
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

function traceToolStepIcon(tool?: string): ReactNode {
  const toolName = String(tool || "").toLowerCase();
  const fileSvg = (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M2 1.75C2 .784 2.784 0 3.75 0h5.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 8.75 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914-.013-.011Z" opacity="0.85" />
    </svg>
  );
  const editSvg = (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M13.23 1h-1.46L3.52 9.25l-.16.22L1 13.59 2.41 15l4.12-2.36.22-.16L15 4.23V2.77L13.23 1zM2.41 13.59l1.51-3 1.45 1.45-2.96 1.55zm3.83-2.06L4.47 9.76l8-8 1.77 1.77-8 8z" />
    </svg>
  );
  const termSvg = (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M0 2.75C0 1.784.784 1 1.75 1h12.5c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0 1 14.25 15H1.75A1.75 1.75 0 0 1 0 13.25V2.75zm1.75-.25a.25.25 0 0 0-.25.25v10.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25V2.75a.25.25 0 0 0-.25-.25H1.75zM7.25 8a.75.75 0 0 1-.22.53l-2.25 2.25a.75.75 0 1 1-1.06-1.06L5.44 8 3.72 6.28a.75.75 0 1 1 1.06-1.06l2.25 2.25c.141.14.22.331.22.53zm1.5 1.5a.75.75 0 0 1 0-1.5h3.5a.75.75 0 0 1 0 1.5h-3.5z" />
    </svg>
  );
  const searchSvg = (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0z" />
    </svg>
  );
  const folderSvg = (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M.54 3.87.5 14a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1V4.5a1 1 0 0 0-1-1H6.414l-.914-.914A2 2 0 0 0 4.086 2H1.5a1 1 0 0 0-1 1v.87z" />
    </svg>
  );
  if (toolName === "write_patch" || toolName === "create_file") return editSvg;
  if (toolName === "run_command") return termSvg;
  if (toolName === "search_code") return searchSvg;
  if (toolName === "list_files") return folderSvg;
  return fileSvg;
}

function traceThoughtStepIcon(): ReactNode {
  return <IconBrain size={14} strokeWidth={1.7} aria-hidden />;
}

/** Wraps consecutive ACTIONs that share the same tool/iteration into a single fold. */
function ActionGroupFold({
  tool,
  count,
  isActive,
  children,
}: {
  tool: string;
  count: number;
  isActive?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(isActive ?? false);
  useEffect(() => { setOpen(Boolean(isActive)); }, [isActive]);
  const t = tool.toLowerCase();
  const meta: { verb: string; noun: string; icon: ReactNode } = (() => {
    const fileSvg = traceToolStepIcon("read_file");
    const editSvg = traceToolStepIcon("write_patch");
    const termSvg = traceToolStepIcon("run_command");
    const searchSvg = traceToolStepIcon("search_code");
    const folderSvg = traceToolStepIcon("list_files");
    if (t === "read_file") return { verb: "Read", noun: count > 1 ? "files" : "file", icon: fileSvg };
    if (t === "list_files") return { verb: "List", noun: count > 1 ? "directories" : "directory", icon: folderSvg };
    if (t === "create_file") return { verb: "Create", noun: count > 1 ? "files" : "file", icon: editSvg };
    if (t === "write_patch") return { verb: "Edit", noun: count > 1 ? "files" : "file", icon: editSvg };
    if (t === "run_command") return { verb: "Run", noun: count > 1 ? "commands" : "command", icon: termSvg };
    if (t === "search_code") return { verb: "Search", noun: count > 1 ? "queries" : "query", icon: searchSvg };
    return { verb: tool, noun: count > 1 ? "calls" : "call", icon: fileSvg };
  })();
  return (
    <details
      className="assistant-action-group"
      open={open}
      onToggle={(ev) => {
        if (ev.currentTarget !== ev.target) return;
        setOpen((ev.currentTarget as HTMLDetailsElement).open);
      }}
    >
      <summary className="assistant-action-fold-sum tool-header assistant-action-group-sum">
        <span className="assistant-action-fold-chev" aria-hidden>
          <ChevronExpand expanded={open} size={15} />
        </span>
        <span className="tool-icon">{meta.icon}</span>
        <span className="tool-action">{meta.verb}</span>
        <span className="assistant-action-group-count">{count} {meta.noun}</span>
      </summary>
      <div className="assistant-action-group-body">
        {Children.map(children, (child) => {
          if (isValidElement(child) && child.type === ActionAccordionFold) {
            return cloneElement(child, { inActionGroup: true } as { inActionGroup?: boolean });
          }
          return child;
        })}
      </div>
    </details>
  );
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
  inActionGroup,
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
  /** Nested under ActionGroupFold — no duplicate tool verb row; body only (paths, names, output). */
  inActionGroup?: boolean;
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
  const saveFailed =
    pairedObservation?.type !== "observation" &&
    !isStreamingTurn &&
    (ev.tool || "").toLowerCase() === "create_file" &&
    (headerStreamingPreview?.includes("</html>") ||
      String((ev.input as Record<string, unknown>)?.content ?? "").includes("</html>"));
  const toolLower = (ev.tool || "").toLowerCase();
  const obsUi = uiObservationToToolObservation(pairedObservation);

  if (inActionGroup) {
    const dir =
      toolLower === "list_files" ? String((ev.input as Record<string, unknown>).dir ?? ".") : null;
    return (
      <div
        className={`assistant-action-group-item${toolLower === "list_files" ? " assistant-action-group-item--list" : ""}`}
      >
        {dir != null && (
          <div className="assistant-action-group-dir" title={dir}>
            {dir}
          </div>
        )}
        <div className="assistant-action-group-item-body">{children}</div>
      </div>
    );
  }

  const header = (
    <ToolAccordionHeader
      tool={ev.tool || "unknown"}
      input={(ev.input || {}) as Record<string, unknown>}
      observation={obsUi}
      streamingArgPreview={headerStreamingPreview}
      diskSettledOk={diskSettledForAction(ev, allEvents)}
      saveFailed={saveFailed}
    />
  );

  return (
    <details
      className="assistant-action-fold assistant-stream-action trace-reasoning"
      open={foldOpen}
      onToggle={(toggleEv) => {
        toggleEv.stopPropagation();
        if (toggleEv.currentTarget !== toggleEv.target) return;
        setFoldOpen((toggleEv.currentTarget as HTMLDetailsElement).open);
      }}
    >
      <summary className="assistant-action-fold-sum assistant-stream-action-sum trace-reasoning-summary">
        <span className="assistant-action-sum-left">{header}</span>
        <span className="assistant-action-fold-chev thought-log-chev" aria-hidden>
          <ChevronExpand expanded={foldOpen} size={15} />
        </span>
      </summary>
      <div className="assistant-action-fold-body assistant-stream-action-body">{children}</div>
    </details>
  );
}

/** Unified thought fold — reasoning (pre-THOUGHT) + THOUGHT body in one row. */
function ThoughtFold({
  isStreamingAssistant,
  markdown,
  startedAt,
  durationMs,
  collapseWhenToolsVisible,
}: {
  isStreamingAssistant: boolean;
  markdown: string;
  startedAt?: number;
  /** Settled thought duration — shown after streaming ends. */
  durationMs?: number;
  collapseWhenToolsVisible?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const initialOpen = Boolean(isStreamingAssistant && !collapseWhenToolsVisible);
  const [open, setOpen] = useState(initialOpen);
  const autoOpenedRef = useRef(initialOpen);
  const lastNonEmptyRef = useRef("");
  const [now, setNow] = useState(() => Date.now());
  if (markdown.trim()) lastNonEmptyRef.current = markdown;
  else if (!isStreamingAssistant) lastNonEmptyRef.current = "";
  const displayMarkdown = markdown.trim()
    ? markdown
    : isStreamingAssistant
      ? lastNonEmptyRef.current
      : markdown;
  const streamingChrome = Boolean(isStreamingAssistant && !collapseWhenToolsVisible);
  useEffect(() => {
    if (collapseWhenToolsVisible) { setOpen(false); return; }
    if (!streamingChrome || !displayMarkdown.trim()) return;
    if (autoOpenedRef.current) return;
    autoOpenedRef.current = true;
    setOpen(true);
  }, [collapseWhenToolsVisible, streamingChrome, displayMarkdown]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [displayMarkdown, open]);
  useEffect(() => {
    if (!streamingChrome || !startedAt) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [streamingChrome, startedAt]);

  const liveMs = streamingChrome && startedAt ? Math.max(0, now - startedAt) : undefined;
  const displayMs = liveMs ?? durationMs;
  const elapsed = displayMs != null ? formatDuration(displayMs) : null;
  const hasMd = displayMarkdown.trim().length > 0;

  // Keep the fold visible while tools run — use last streamed text when collapsed.
  if (!hasMd && !isStreamingAssistant && !lastNonEmptyRef.current.trim()) return null;

  const summaryPrimary = elapsed
    ? `Thought · ${elapsed}`
    : streamingChrome
      ? hasMd ? "Thought…" : "Thought…"
      : "Thought";

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
            {isStreamingAssistant
              ? <div className="streaming-plaintext">{displayMarkdown}</div>
              : <Markdown>{displayMarkdown}</Markdown>
            }
          </div>
        ) : (
          <div className="assistant-stream-thought-placeholder">Thought…</div>
        )}
      </div>
    </details>
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
  if (e.type === "reasoning" || e.type === "thought") {
    return null;
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
    const saveFailed =
      !obs &&
      !isStreamingTurn &&
      toolName === "create_file" &&
      (argPeek?.includes("</html>") || String((e.input as Record<string, unknown>)?.content ?? "").includes("</html>"));
    return (
      <div className="trace-tool-row trace-tool-output">
        <ToolOutput
          tool={e.tool || "unknown"}
          input={e.input || {}}
          observation={obs}
          streamPreview={streamPreview}
          streamingArgPreview={argPeek}
          diskSettledOk={diskSettledForAction(e, allEvents)}
          saveFailed={saveFailed}
          suppressHeader={suppressToolHeader}
          suppressObservationFollowup={suppressWritePatchObservationFollowup}
        />
      </div>
    );
  }

  if (e.type === "log") {
    return null;
  }

  if (e.type === "policy_decision") {
    return null;
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

function AssistantMessageBase({
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
  settledReasoningMap,
  settledThoughtMap,
  settledThoughtDurationMap,
  streamingThoughtStartedAt,
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
  /** Reasoning trace tokens saved per iteration before THOUGHT:. */
  settledReasoningMap?: Map<number, string>;
  /** THOUGHT: tokens saved per iteration when the parsed event has not rendered before ACTION. */
  settledThoughtMap?: Map<number, string>;
  /** Thought phase duration (ms) per iteration — live-settled + reloaded from events. */
  settledThoughtDurationMap?: Map<number, number>;
  /** Wall-clock start of the current streaming thought iteration. */
  streamingThoughtStartedAt?: number;
}) {
  const events = turn.events as UIEvent[];
  const finalEv = [...events].reverse().find((e) => e.type === "final");
  const errorEv = [...events].reverse().find((e) => e.type === "error");
  const checkpointEv = events.find((e) => e.type === "checkpoint" && e.checkpoint);
  const checkpoint = checkpointEv?.checkpoint as Checkpoint | undefined;
  const policyDeniedCount = events.filter((e) => e.type === "policy_decision" && e.decision === "deny").length;
  // Recomputing traceSteps every render is the dominant cost during a long
  // agent run (filter + sort over hundreds of events on each token tick).
  // Memoize on the events array reference — patchSession produces a new
  // events ref only for the turn it touched, so this gates correctly.
  const traceSteps = useMemo(() => {
    const filtered = (events as UIEvent[]).filter(
      (e) =>
        e.type === "thought" ||
        e.type === "reasoning" ||
        e.type === "action" ||
        e.type === "observation" ||
        e.type === "command_chunk" ||
        (e.type === "activity" &&
          ["prepare", "index", "context"].includes(String(e.phase ?? ""))) ||
        (e.type === "log" && !isRedundantUiLog(e)) ||
        (e.type === "policy_decision" &&
          (e.decision === "deny" || e.decision === "allow_always")),
    );
    const deduped = dedupeTraceTimelineEvents(filtered);
    return [...deduped].sort((a, b) => {
      const ta = (a as UIEvent).ts ?? 0;
      const tb = (b as UIEvent).ts ?? 0;
      const ia = Number((a as UIEvent).iteration) || 1;
      const ib = Number((b as UIEvent).iteration) || 1;
      if (ia !== ib) {
        if (!ta || !tb) return 0;
        return ta - tb;
      }
      const typeRank = (e: { type: string }): number => {
        if (e.type === "reasoning") return 0;
        if (e.type === "thought") return 1;
        if (e.type === "activity") return 2;
        if (e.type === "log") return 3;
        if (e.type === "policy_decision") return 4;
        if (e.type === "action") return 5;
        if (e.type === "observation") return 6;
        return 5;
      };
      const ra = typeRank(a as UIEvent);
      const rb = typeRank(b as UIEvent);
      if (ra !== rb) return ra - rb;
      if (!ta || !tb) return 0;
      return ta - tb;
    });
  }, [events]);
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
  // Reasoning trace = text BEFORE THOUGHT: — shown in the live streaming box
  const streamingReasoningMarkdown = useMemo(
    () => (isStreaming && streamingText.trim() ? streamingReasoningExtract(streamingText) : ""),
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

  // (removed) streamPulse: previously forced a 400ms re-render of every
  // MessageRow during streaming with NO consumer (the original elapsed-time
  // counter that read it was deleted). Wasted ~2.5 renders/sec per row;
  // dropping it noticeably reduces jank during long agent runs.

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
        const groupKeys: (string | undefined)[] = [];
        const iterKeys: (number | undefined)[] = [];
        const pendingGroupKeys = new Set<string>();
        const stepIcons: React.ReactNode[] = [];
        type StepKind = "thought" | "tool" | "other";
        const stepKinds: StepKind[] = [];
        const pushNode = (
          node: React.ReactNode,
          groupKey?: string,
          iterKey?: number,
          stepIcon?: React.ReactNode,
          kind: StepKind = "other",
        ): void => {
          rendered.push(node);
          groupKeys.push(groupKey);
          iterKeys.push(iterKey);
          stepIcons.push(stepIcon ?? null);
          stepKinds.push(kind);
        };
        const skipIndices = new Set<number>();
        let liveFoldInjected = false;

        const thoughtIndexByIter = new Map<number, number>();
        const reasoningIndexByIter = new Map<number, number>();
        traceSteps.forEach((step, idx) => {
          const iter = Number((step as UIEvent).iteration) || 1;
          if (step.type === "thought" && (step.thought ?? "").trim()) {
            if (!thoughtIndexByIter.has(iter)) thoughtIndexByIter.set(iter, idx);
          }
          if (step.type === "reasoning" && String(step.reasoning ?? "").trim()) {
            if (!reasoningIndexByIter.has(iter)) reasoningIndexByIter.set(iter, idx);
          }
        });

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

        /** Iterations for which the unified Thought fold was rendered. */
        const thoughtBlockInjected = new Set<number>();

        function collectThoughtMarkdown(iter: number): string {
          if (iter === streamThoughtIter && isStreaming) {
            return mergeThoughtBody(streamingReasoningMarkdown, streamingThoughtMarkdown);
          }
          let reasoning = "";
          let thought = "";
          const rIdx = reasoningIndexByIter.get(iter);
          if (rIdx != null) reasoning = String((traceSteps[rIdx] as UIEvent).reasoning ?? "");
          const tIdx = thoughtIndexByIter.get(iter);
          if (tIdx != null) thought = String((traceSteps[tIdx] as UIEvent).thought ?? "");
          if (!reasoning.trim()) reasoning = settledReasoningMap?.get(iter) ?? "";
          if (!thought.trim()) thought = settledThoughtMap?.get(iter) ?? "";
          return mergeThoughtBody(reasoning, thought);
        }

        function pushThoughtForIter(iter: number): void {
          if (thoughtBlockInjected.has(iter)) return;
          const body = collectThoughtMarkdown(iter);
          const isLive = isStreaming && iter === streamThoughtIter && wantLiveThoughtPanel;
          if (!body.trim() && !isLive) return;
          thoughtBlockInjected.add(iter);
          const tIdx = thoughtIndexByIter.get(iter);
          const rIdx = reasoningIndexByIter.get(iter);
          if (tIdx != null) skipIndices.add(tIdx);
          if (rIdx != null) skipIndices.add(rIdx);
          const durationMs = thoughtDurationMsForIter(events as UIEvent[], iter, settledThoughtDurationMap);
          const liveStartedAt =
            isLive && !thoughtCollapseForTools && iter === streamThoughtIter
              ? streamingThoughtStartedAt
              : undefined;
          pushNode(
            <ThoughtFold
              key={`thought-${turn.id}-${iter}`}
              isStreamingAssistant={isLive}
              markdown={body}
              startedAt={liveStartedAt}
              durationMs={!isLive || (isLive && thoughtCollapseForTools) ? durationMs : undefined}
              collapseWhenToolsVisible={isLive ? thoughtCollapseForTools : false}
            />,
            undefined,
            iter,
            traceThoughtStepIcon(),
            "thought",
          );
          if (iter === streamThoughtIter) liveFoldInjected = true;
        }

        function pushLiveThoughtIfNeeded(_marker: string) {
          if (liveFoldInjected || !wantLiveThoughtPanel) return;
          pushThoughtForIter(streamThoughtIter);
        }

        traceSteps.forEach((e, i) => {
          if (skipIndices.has(i)) return;
          if (e.type === "command_chunk") return;

          if (e.type === "thought" || e.type === "reasoning") {
            return;
          }

          if (e.type === "action") {
            const ev = e as UIEvent;
            const streamOrd = streamedActionOrdinalAtStep(traceSteps as UIEvent[], i);
            const actIter = Number(ev.iteration) || 1;

            if (!liveFoldInjected && actIter === streamThoughtIter) {
              pushLiveThoughtIfNeeded("before_action");
            }
            pushThoughtForIter(actIter);

            let stream = "";
            let k = i - 1;
            while (k >= 0 && traceSteps[k].type === "command_chunk") {
              const ch = traceSteps[k] as UIEvent;
              if (ev.iteration !== undefined && ch.iteration !== undefined && ch.iteration !== ev.iteration) break;
              const t = String(ch.text ?? "");
              if (t) stream = (ch.stream === "stderr" ? `[stderr] ${t}` : t) + stream;
              skipIndices.add(k);
              k--;
            }
            let j = i + 1;
            while (j < traceSteps.length && traceSteps[j].type === "command_chunk") {
              const ch = traceSteps[j] as UIEvent;
              if (ev.iteration !== undefined && ch.iteration !== undefined && ch.iteration !== ev.iteration) break;
              const t = String(ch.text ?? "");
              if (t) stream += ch.stream === "stderr" ? `[stderr] ${t}` : t;
              skipIndices.add(j);
              j++;
            }
            const paired = firstObservationAfter(traceSteps, j, ev.iteration, {
              actionKey: ev.actionKey,
              tool: ev.tool,
              input: (ev.input ?? {}) as Record<string, unknown>,
            });
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
              const pathSuffix =
                (ev.tool || "").toLowerCase() === "create_file"
                  ? `create-${String((inp as Record<string, unknown>).path ?? "file").replace(/\\/g, "/")}`
                  : `step-${i}`;
              const groupKey = actionGroupKey(ev.tool || "tool", actIter, pathSuffix);
              if (!paired && isStreaming) pendingGroupKeys.add(groupKey);
              pushNode(
                (
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
                </ActionAccordionFold>
                ),
                groupKey,
                actIter,
                traceToolStepIcon(ev.tool),
                "tool",
              );
            } else {
              patchSlices.forEach((slice, fi) => {
                const slug = writePatchAccordionSlug(slice, fi);
                const groupKey = actionGroupKey(ev.tool || "tool", actIter, `file-${slug}`);
                if (!paired && isStreaming && fi === 0) pendingGroupKeys.add(groupKey);
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

                pushNode(
                  (
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
                  </ActionAccordionFold>
                  ),
                  groupKey,
                  actIter,
                  traceToolStepIcon(ev.tool),
                  "tool",
                );
              });
            }

            if (paired && !paired.combined) skipIndices.add(paired.idx);
            return;
          }

          const ev = e as UIEvent;

          if (ev.type === "activity") {
            pushNode(
              <TraceActivityRow key={`act-${i}`} label={String(ev.label ?? "")} />,
              undefined,
              undefined,
            );
            return;
          }

          if (ev.type === "log") {
            const level = ev.level === "error" ? "error" : ev.level === "warn" ? "warn" : "info";
            pushNode(
              <TraceLogRow key={`log-${i}`} level={level} message={String(ev.message ?? "")} />,
              undefined,
              undefined,
            );
            return;
          }

          if (ev.type === "policy_decision") {
            pushNode(
              <TracePolicyRow
                key={`pol-${i}`}
                decision={String(ev.decision ?? "")}
                cmd={String(ev.cmd ?? ev.originalCmd ?? "")}
                reason={String(ev.reason ?? "")}
              />,
              undefined,
              Number(ev.iteration) || undefined,
            );
            return;
          }

          pushNode(
            <TraceStep
              key={`misc-${i}`}
              e={ev}
              allEvents={events as UIEvent[]}
              streamingPartial={streamingText}
              isStreamingTurn={isStreaming}
            />,
            undefined,
            Number(ev.iteration) || undefined,
            ev.type === "thought" || ev.type === "reasoning" ? traceThoughtStepIcon() : undefined,
          );
        });

        let activeGroupKey: string | undefined;
        if (
          streamPeekAction &&
          !(
            isWriteToolName(streamPeekAction.tool) &&
            writeActionCountForIteration(traceSteps as UIEvent[], Number(streamPeekAction.iteration) || 1) > 0
          )
        ) {
          const peekIt = Number(streamPeekAction.iteration) || 1;
          const peekPairedObs = observationForStreamingPeek(streamPeekAction, events as UIEvent[]);
          /** Synthetic peek row aligns with buffered ACTION blobs not yet flushed as SSE `action` events. */
          const peekStreamOrd = streamedActionCountForIteration(traceSteps as UIEvent[], peekIt);
          if (!liveFoldInjected && peekIt === streamThoughtIter) {
            pushLiveThoughtIfNeeded("before_peek");
          }
          pushThoughtForIter(peekIt);
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

          const peekTool = streamPeekAction.tool || "tool";
          const pushPeekSingle = (): void => {
            const peekKey = actionGroupKey(peekTool, peekIt, `peek-${peekStreamOrd}`);
            activeGroupKey = peekKey;
            if (isStreaming) pendingGroupKeys.add(peekKey);
            pushNode(
              (
              <ActionAccordionFold
                key={`acc-peek-${streamPeekAction.iteration}-${streamPeekAction.tool}-${String(streamPeekAction.input?.path ?? "patch")}`}
                ev={streamPeekAction}
                pairedObservation={peekPairedObs}
                streamingPartial={streamingText}
                isStreamingTurn={isStreaming}
                allEvents={events as UIEvent[]}
                streamingActionOrdinal={peekStreamOrd}
              >
                <TraceStep
                  key="stream-peek-ts"
                  e={streamPeekAction}
                  observation={peekPairedObs}
                  allEvents={events as UIEvent[]}
                  streamingPartial={streamingText}
                  isStreamingTurn={isStreaming}
                  streamingActionOrdinal={peekStreamOrd}
                  suppressToolHeader
                />
              </ActionAccordionFold>
              ),
              peekKey,
              peekIt,
              traceToolStepIcon(streamPeekAction.tool),
              "tool",
            );
          };

          if (!peekSlices) {
            pushPeekSingle();
          } else {
            peekSlices.forEach((slice, fi) => {
              const slug = writePatchAccordionSlug(slice, fi);
              const peekKey = actionGroupKey(peekTool, peekIt, `peek-${peekStreamOrd}-file-${slug}`);
              if (fi === 0) {
                activeGroupKey = peekKey;
                if (isStreaming) pendingGroupKeys.add(peekKey);
              }
              const sliceEv = {
                ...streamPeekAction,
                input: { ...basePeekInp, patches: slice },
              } as UIEvent;
              pushNode(
                (
                <ActionAccordionFold
                  key={`acc-peek-${streamPeekAction.iteration}-wp-${fi}-${slug}`}
                  ev={sliceEv}
                  pairedObservation={peekPairedObs}
                  streamingPartial={streamingText}
                  isStreamingTurn={isStreaming}
                  allEvents={events as UIEvent[]}
                  streamingActionOrdinal={peekStreamOrd}
                  writePatchHeaderPreview={peekWritePatchSectionNth(streamingText, peekStreamOrd, fi) ?? slice}
                >
                  <TraceStep
                    key={`stream-peek-ts-${fi}`}
                    e={sliceEv}
                    observation={peekPairedObs}
                    streamingWritePatchArg={peekWritePatchSectionNth(streamingText, peekStreamOrd, fi) ?? ""}
                    allEvents={events as UIEvent[]}
                    streamingPartial={streamingText}
                    isStreamingTurn={isStreaming}
                    streamingActionOrdinal={peekStreamOrd}
                    suppressToolHeader
                    suppressWritePatchObservationFollowup={fi !== 0}
                  />
                </ActionAccordionFold>
                ),
                peekKey,
                peekIt,
                traceToolStepIcon(streamPeekAction.tool),
                "tool",
              );
            });
          }
        }

        if (!liveFoldInjected && wantLiveThoughtPanel) {
          pushLiveThoughtIfNeeded("eof_tail");
        }

        const finalRendered: React.ReactNode[] = [];
        const finalIterKeys: (number | undefined)[] = [];
        const finalStepIcons: React.ReactNode[] = [];
        const finalStepKinds: StepKind[] = [];
        for (let p = 0; p < rendered.length; ) {
          const k = groupKeys[p];
          if (!k) {
            finalRendered.push(rendered[p]);
            finalIterKeys.push(iterKeys[p]);
            finalStepIcons.push(stepIcons[p]);
            finalStepKinds.push(stepKinds[p]);
            p++;
            continue;
          }
          let q = p + 1;
          while (q < rendered.length && groupKeys[q] === k) q++;
          const tool = k.split("#")[0] ?? "tool";
          for (let r = p; r < q; r++) {
            finalRendered.push(rendered[r]);
            finalIterKeys.push(iterKeys[r]);
            finalStepIcons.push(stepIcons[r] ?? traceToolStepIcon(tool));
            finalStepKinds.push(stepKinds[r]);
          }
          p = q;
        }
        const groupedByIteration: React.ReactNode[] = [];
        for (let p = 0; p < finalRendered.length; ) {
          const iter = finalIterKeys[p];
          if (iter == null) { groupedByIteration.push(finalRendered[p]); p++; continue; }
          let q = p + 1;
          while (q < finalRendered.length && finalIterKeys[q] === iter) q++;
          const items = finalRendered.slice(p, q);
          let actionCount = traceSteps.filter(
            (e) => e.type === "action" && (Number((e as UIEvent).iteration) || 1) === iter,
          ).length;
          if (
            isStreaming &&
            streamPeekAction &&
            (Number(streamPeekAction.iteration) || 1) === iter &&
            !traceSteps.some(
              (e) =>
                e.type === "action" &&
                (Number((e as UIEvent).iteration) || 1) === iter &&
                String((e as UIEvent).tool ?? "").toLowerCase() ===
                  String(streamPeekAction.tool ?? "").toLowerCase(),
            )
          ) {
            actionCount += 1;
          }
          const hasThought = finalStepKinds.slice(p, q).some((k) => k === "thought");
          if (items.length === 1) {
            groupedByIteration.push(items[0]);
          } else {
            const meta =
              actionCount > 0
                ? `${actionCount} action${actionCount === 1 ? "" : "s"}`
                : hasThought
                  ? `${items.length} items`
                  : `${items.length} actions`;
            groupedByIteration.push(
              <div key={`trace-iter-${turn.id}-${iter}-${p}`} className="trace-iteration-block">
                <div className="trace-iteration-head">
                  <span className="trace-iteration-label">Step {iter}</span>
                  <span className="trace-iteration-meta">{meta}</span>
                </div>
                <div className="trace-iteration-body">
                  {items.map((item, idx) => (
                    <div key={`${iter}-step-${idx}`} className="trace-iteration-step">
                      {item}
                    </div>
                  ))}
                </div>
              </div>,
            );
          }
          p = q;
        }
        return groupedByIteration;
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
            {/* During streaming, skip markdown parse (react-markdown+prism is too
                expensive at 60fps). Render plain pre-wrap text; full Markdown
                renders once the turn settles and finalText arrives. */}
            {(isStreaming && !finalText)
              ? <div className="streaming-plaintext">{displayedFinalText}</div>
              : <Markdown>{displayedFinalText}</Markdown>
            }
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

// Memoized — only re-render when the data the row actually displays moved.
// Inline callbacks from the chat-turn `.map(...)` get a fresh identity on
// every parent render; ignoring them lets old/inactive turns skip rendering
// entirely while the active streaming turn keeps updating.
const AssistantMessage = memo(AssistantMessageBase, (a, b) => {
  if (a.turn !== b.turn) return false;
  if (a.isStreaming !== b.isStreaming) return false;
  if (a.canRegenerate !== b.canRegenerate) return false;
  if (a.settledReasoningMap !== b.settledReasoningMap) return false;
  if (a.settledThoughtMap !== b.settledThoughtMap) return false;
  if (a.settledThoughtDurationMap !== b.settledThoughtDurationMap) return false;
  if (a.isStreaming) {
    if (a.streamingText !== b.streamingText) return false;
    if (a.streamingIteration !== b.streamingIteration) return false;
    if (a.streamingThoughtStartedAt !== b.streamingThoughtStartedAt) return false;
    if (a.awaitingStop !== b.awaitingStop) return false;
    if (a.sessionConnecting !== b.sessionConnecting) return false;
  }
  return true;
});

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
  // ComposerEditable syncs via value + valueVersion.
  const [task, setTask] = useState("");
  const [taskVersion, setTaskVersion] = useState(0);
  const [selectElRefsVersion, setSelectElRefsVersion] = useState(0);
  const [composerMentions, setComposerMentions] = useState<string[]>([]);
  const [taskHasContent, setTaskHasContent] = useState(false);
  const browserElementRefsRef = useRef(new Map<string, BrowserElementRef>());
  const nextSelectElRef = useRef(1);

  // Stable onChange — does NOT call setTask, so Chat does
  // not re-render on every keystroke. Uses startTransition so React 18 marks
  // these updates as interruptible: user input always takes priority.
  const handleComposerChange = useCallback((v: string) => {
    taskRef.current = v;
    startTransition(() => {
      setComposerMentions(prev => {
        const next = extractMentions(v);
        return next.join("\0") === prev.join("\0") ? prev : next;
      });
      const hasText = stripSelectElTokens(v).trim().length > 0;
      const hasSelect = extractSelectElKeys(v).length > 0;
      setTaskHasContent(hasText || hasSelect);
    });
  }, []);

  // Helper for external updates (inject, clear, slash, drag-drop).
  const commitComposerValue = useCallback((v: string) => {
    taskRef.current = v;
    setTask(v);
    setTaskVersion((n) => n + 1);
    setComposerMentions(extractMentions(v));
    const hasText = stripSelectElTokens(v).trim().length > 0;
    const hasSelect = extractSelectElKeys(v).length > 0;
    setTaskHasContent(hasText || hasSelect);
  }, []);

  const setTaskExternal = useCallback((vOrFn: string | ((prev: string) => string)) => {
    const v = typeof vOrFn === "function" ? vOrFn(taskRef.current) : vOrFn;
    commitComposerValue(v);
  }, [commitComposerValue]);

  const addBrowserElementPick = useCallback((pick: BrowserElementPickDetail) => {
    const n = nextSelectElRef.current++;
    const key = selectElKeyFromIndex(n);
    const token = formatSelectElToken(n);
    browserElementRefsRef.current.set(key, {
      key,
      ...pick,
      tagLabel: tagLabelFromPath(pick.path),
    });
    setSelectElRefsVersion((v) => v + 1);
    setTaskExternal((t) => {
      const trimmed = t.replace(/\s+$/, "");
      return trimmed.length === 0 ? `${token} ` : `${trimmed} ${token} `;
    });
  }, [setTaskExternal]);

  useEffect(() => {
    const onPick = (e: Event) => {
      addBrowserElementPick((e as CustomEvent<BrowserElementPickDetail>).detail);
    };
    window.addEventListener(BROWSER_ELEMENT_PICK_EVENT, onPick);
    return () => window.removeEventListener(BROWSER_ELEMENT_PICK_EVENT, onPick);
  }, [addBrowserElementPick]);

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
  const [contextUsage, setContextUsage] = useState<ContextUsage>({
    segments: [],
    totalTokens: 0,
    limitTokens: 128_000,
    percent: 0,
    source: "preview",
  });
  /** True after Stop/Esc until the run finishes cleanup (SSE close + abort acknowledged). */
  const [awaitingStop, setAwaitingStop] = useState(false);
  const [thinking, setThinking] = useState<{ iteration: number; partial: string; startedAt: number } | null>(null);
  const thinkingRef = useRef<{ iteration: number; partial: string; startedAt: number } | null>(null);
  /** Reasoning Trace content saved per iteration when iter_start resets the live buffer. */
  const [settledReasoning, setSettledReasoning] = useState<Map<string, Map<number, string>>>(new Map());
  /** THOUGHT content saved per iteration independently from Reasoning Trace. */
  const [settledThoughts, setSettledThoughts] = useState<Map<string, Map<number, string>>>(new Map());
  /** Thought-phase duration (ms) per turn + iteration — persisted on thought events too. */
  const [settledThoughtDurations, setSettledThoughtDurations] = useState<Map<string, Map<number, number>>>(new Map());
  const thoughtStartByTurnRef = useRef<Map<string, Map<number, number>>>(new Map());
  /** Sticky-tail state for "↓ Latest" affordance. */
  const [autoScroll, setAutoScroll] = useState(true);
  const autoScrollRef = useRef(true);
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const chatScrollerRef = useRef<HTMLElement | null>(null);
  /** Ignore transient atBottom=false while we programmatically stick to tail. */
  const programmaticUntilRef = useRef(0);
  const atBottomDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wheelCleanupRef = useRef<(() => void) | null>(null);

  const enableAutoScroll = useCallback(() => {
    autoScrollRef.current = true;
    setAutoScroll(true);
  }, []);

  const stickToBottom = useCallback(() => {
    if (!autoScrollRef.current) return;
    programmaticUntilRef.current = performance.now() + 280;
    const v = virtuosoRef.current;
    const scroller = chatScrollerRef.current;
    v?.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" });
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    requestAnimationFrame(() => {
      if (!autoScrollRef.current) return;
      v?.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" });
      const sc = chatScrollerRef.current;
      if (sc) sc.scrollTop = sc.scrollHeight;
    });
  }, []);

  const scrollToBottom = useCallback(() => {
    enableAutoScroll();
    stickToBottom();
    const t = setTimeout(stickToBottom, 120);
    return () => clearTimeout(t);
  }, [enableAutoScroll, stickToBottom]);

  const bindChatScroller = useCallback((el: HTMLElement | Window | null) => {
    if (wheelCleanupRef.current) {
      wheelCleanupRef.current();
      wheelCleanupRef.current = null;
    }
    const node = el instanceof HTMLElement ? el : null;
    chatScrollerRef.current = node;
    if (!node) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < -2) {
        autoScrollRef.current = false;
        setAutoScroll(false);
        programmaticUntilRef.current = 0;
        if (atBottomDebounceRef.current != null) {
          clearTimeout(atBottomDebounceRef.current);
          atBottomDebounceRef.current = null;
        }
      }
    };
    node.addEventListener("wheel", onWheel, { passive: true });
    wheelCleanupRef.current = () => node.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => () => wheelCleanupRef.current?.(), []);

  const streamTailKey = useMemo(() => {
    const turns = session.turns;
    const last = turns[turns.length - 1];
    return [
      running ? 1 : 0,
      turns.length,
      last?.events?.length ?? 0,
      thinking?.partial?.length ?? 0,
      thinking?.iteration ?? 0,
    ].join(":");
  }, [running, session.turns, thinking?.partial, thinking?.iteration]);

  useLayoutEffect(() => {
    if (!running || !autoScrollRef.current) return;
    stickToBottom();
  }, [streamTailKey, running, stickToBottom]);

  useEffect(() => {
    // Release per-turn in-memory buffers from the previous session.
    setSettledReasoning(new Map());
    setSettledThoughts(new Map());
    setSettledThoughtDurations(new Map());
    thoughtStartByTurnRef.current = new Map();
    setThinking(null);
    // Scroll to bottom when switching sessions / workspace.
    return scrollToBottom();
  }, [session.id, workspace, scrollToBottom]);

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

  const cmdChunkRafRef = useRef<number | null>(null);
  const cmdChunkPendingRef = useRef<{
    turnId: string;
    iteration: number;
    stream: "stdout" | "stderr";
    text: string;
  } | null>(null);

  useEffect(() => {
    if (sessionRef.current.id !== session.id) sessionRef.current = session;
  }, [session.id]);

  const flushTokenRaf = useCallback(() => {
    tokenRafRef.current = null;
    const add = tokenPendingRef.current;
    if (!add) return;
    tokenPendingRef.current = "";
    const it = tokenIterRef.current;
    const cur = thinkingRef.current;
    const next = {
      iteration: it ?? cur?.iteration ?? 1,
      partial: capStreamingBuffer((cur?.partial ?? "") + add),
      startedAt: cur?.startedAt ?? Date.now(),
    };
    thinkingRef.current = next;
    setThinking(next);
    stickToBottom();
  }, [stickToBottom]);

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
  const applyCmdChunkPending = useCallback((pending: {
    turnId: string;
    iteration: number;
    stream: "stdout" | "stderr";
    text: string;
  }) => {
    const { turnId, iteration, stream, text } = pending;
    if (!text) return;
    patchSession((s) => {
      const turns = s.turns.slice();
      const idx = turns.findIndex((x) => x.id === turnId);
      if (idx === -1) return s;
      const existing = turns[idx].events as UIEvent[];
      const last = existing[existing.length - 1];
      if (last?.type === "command_chunk" && Number(last.iteration ?? 1) === iteration) {
        const merged: UIEvent = {
          ...last,
          text: String(last.text ?? "") + text,
          ts: Date.now(),
        };
        turns[idx] = { ...turns[idx], events: [...existing.slice(0, -1), merged] };
      } else {
        turns[idx] = {
          ...turns[idx],
          events: [
            ...existing,
            { type: "command_chunk", iteration, stream, text, ts: Date.now() } as UIEvent,
          ],
        };
      }
      return { ...s, turns, updatedAt: Date.now() };
    });
    if (autoScrollRef.current) stickToBottom();
  }, [stickToBottom]);

  const flushCmdChunkRaf = useCallback(() => {
    cmdChunkRafRef.current = null;
    const pending = cmdChunkPendingRef.current;
    if (!pending?.text) return;
    cmdChunkPendingRef.current = null;
    applyCmdChunkPending(pending);
  }, [applyCmdChunkPending]);

  const flushCmdChunkNow = useCallback(() => {
    if (cmdChunkRafRef.current != null) {
      cancelAnimationFrame(cmdChunkRafRef.current);
      cmdChunkRafRef.current = null;
    }
    flushCmdChunkRaf();
  }, [flushCmdChunkRaf]);

  const scheduleCmdChunkRaf = useCallback(() => {
    if (cmdChunkRafRef.current != null) return;
    cmdChunkRafRef.current = requestAnimationFrame(flushCmdChunkRaf);
  }, [flushCmdChunkRaf]);

  const flushPendingTokensNow = useCallback(() => {
    cancelTokenRaf();
    const add = tokenPendingRef.current;
    if (!add) return;
    tokenPendingRef.current = "";
    const it = tokenIterRef.current;
    const cur = thinkingRef.current;
    const next = {
      iteration: it ?? cur?.iteration ?? 1,
      partial: capStreamingBuffer((cur?.partial ?? "") + add),
      startedAt: cur?.startedAt ?? Date.now(),
    };
    thinkingRef.current = next;
    setThinking(next);
    stickToBottom();
  }, [cancelTokenRaf, stickToBottom]);

  const markThoughtStart = useCallback((turnId: string, iteration: number) => {
    let byTurn = thoughtStartByTurnRef.current.get(turnId);
    if (!byTurn) {
      byTurn = new Map();
      thoughtStartByTurnRef.current.set(turnId, byTurn);
    }
    if (!byTurn.has(iteration)) byTurn.set(iteration, Date.now());
  }, []);

  const finalizeThoughtDuration = useCallback((turnId: string, iteration: number, endAt = Date.now()): number | undefined => {
    const byTurn = thoughtStartByTurnRef.current.get(turnId);
    const start = byTurn?.get(iteration);
    if (start == null) return undefined;
    const ms = Math.max(0, endAt - start);
    byTurn!.delete(iteration);
    setSettledThoughtDurations((prev) => {
      const next = new Map(prev);
      const byIter = new Map(next.get(turnId) ?? []);
      byIter.set(iteration, ms);
      next.set(turnId, byIter);
      return next;
    });
    return ms;
  }, []);

  // ---- Reconnect to running backend session after F5/reload ----
  const processSessionEvent = useCallback((
    ev: UIEvent,
    turnId: string,
  ) => {
    if (ev.type === "token") {
      const it = ev.iteration ?? tokenIterRef.current ?? thinkingRef.current?.iteration ?? 1;
      markThoughtStart(turnId, it);
      tokenPendingRef.current += ev.delta ?? "";
      if (ev.iteration != null) tokenIterRef.current = ev.iteration;
      scheduleTokenRaf();
      return;
    }

    flushPendingTokensNow();

    const appendTurnEvent = (event: UIEvent, uniqueKey?: (x: UIEvent) => boolean): void => {
      const stamped: UIEvent = event.ts ? event : { ...event, ts: Date.now() };
      patchSession((s) => {
        const turns = s.turns.slice();
        const idx = turns.findIndex((x) => x.id === turnId);
        if (idx === -1) return s;
        const existing = turns[idx].events as UIEvent[];
        if (uniqueKey && existing.some(uniqueKey)) return s;
        turns[idx] = { ...turns[idx], events: [...existing, stamped] };
        return { ...s, turns, updatedAt: Date.now() };
      });
    };

    const persistReasoningFromBuffer = (iteration: number, partial: string): void => {
      const reasoning = streamingReasoningExtract(partial).trim();
      if (!reasoning) return;
      setSettledReasoning((m) => {
        const next = new Map(m);
        const byIter = new Map(next.get(turnId) ?? []);
        if (!byIter.has(iteration)) {
          byIter.set(iteration, reasoning);
          next.set(turnId, byIter);
        }
        return next;
      });
      appendTurnEvent(
        { type: "reasoning", iteration, reasoning } as UIEvent,
        (x) => x.type === "reasoning" && Number(x.iteration) === iteration,
      );
    };

    const persistThoughtFromBuffer = (iteration: number, partial: string): void => {
      const thought = streamingThoughtExtract(partial).trim();
      if (!thought) return;
      const thoughtMs = finalizeThoughtDuration(turnId, iteration);
      setSettledThoughts((m) => {
        const next = new Map(m);
        const byIter = new Map(next.get(turnId) ?? []);
        if (!byIter.has(iteration)) {
          byIter.set(iteration, thought);
          next.set(turnId, byIter);
        }
        return next;
      });
      appendTurnEvent(
        { type: "thought", iteration, thought, thoughtMs } as UIEvent,
        (x) => x.type === "thought" && Number(x.iteration) === iteration,
      );
    };

    const snapshotThoughtBuffer = (iteration: number): void => {
      const cur = thinkingRef.current;
      if (!cur?.partial.trim() || cur.iteration !== iteration) return;
      persistReasoningFromBuffer(iteration, cur.partial);
      persistThoughtFromBuffer(iteration, cur.partial);
    };

    if (ev.type === "action") {
      snapshotThoughtBuffer(Number(ev.iteration ?? 1));
      finalizeThoughtDuration(turnId, Number(ev.iteration ?? 1));
    }

    let stampedThoughtMs: number | undefined;

    if (ev.type === "thought") {
      const cur = thinkingRef.current;
      const ti = ev.iteration ?? cur?.iteration ?? 1;
      if (cur && cur.iteration === ti) snapshotThoughtBuffer(ti);
      const fromEv = String(ev.thought ?? "").trim();
      if (fromEv) {
        setSettledThoughts((m) => {
          const next = new Map(m);
          const byIter = new Map(next.get(turnId) ?? []);
          byIter.set(ti, fromEv);
          next.set(turnId, byIter);
          return next;
        });
      }
      stampedThoughtMs = finalizeThoughtDuration(turnId, ti);
      if (cur) {
        // Preserve FINAL: tail so streaming answer stays visible token-by-token
        // instead of disappearing until the complete `final` event arrives.
        const finalTail = streamingFinalExtract(cur.partial);
        const kept = finalTail ? `FINAL: ${finalTail}` : "";
        const next = { iteration: cur.iteration, partial: kept, startedAt: cur.startedAt };
        thinkingRef.current = next;
        setThinking(next);
      }
    }

    if (ev.type === "iter_start") {
      const cur = thinkingRef.current;
      const it = ev.iteration ?? 1;
      if (cur) {
        if (cur.partial.trim()) {
          persistReasoningFromBuffer(cur.iteration, cur.partial);
          persistThoughtFromBuffer(cur.iteration, cur.partial);
        } else {
          finalizeThoughtDuration(turnId, cur.iteration);
        }
      }
      const startedAt = Date.now();
      markThoughtStart(turnId, it);
      // Carry over any FINAL: tail so the streaming answer keeps rendering.
      const prevFinal = cur ? streamingFinalExtract(cur.partial) : "";
      const kept = prevFinal ? `FINAL: ${prevFinal}` : "";
      const next = { iteration: it, partial: kept, startedAt };
      thinkingRef.current = next;
      setThinking(next);
      tokenIterRef.current = it;
      return;
    }

    if (ev.type === "final" || ev.type === "error" || ev.type === "aborted") {
      flushCmdChunkNow();
      // Flush remaining tokens INTO the buffer BEFORE clearing it so the
      // final snapshot of reasoning/thought text is complete.
      flushPendingTokensNow();
      const cur = thinkingRef.current;
      if (cur?.partial.trim()) {
        persistReasoningFromBuffer(cur.iteration, cur.partial);
        persistThoughtFromBuffer(cur.iteration, cur.partial);
      } else if (cur) {
        finalizeThoughtDuration(turnId, cur.iteration);
      }
      thinkingRef.current = null;
      setThinking(null);
    }
    if (ev.type === "context_usage") {
      const usage = contextUsageFromEvent(ev as Record<string, unknown>);
      if (usage) setContextUsage(usage);
    }

    if (ev.type === "policy_ask" && ev.askId && ev.cmd) {
      startTransition(() => {
        setApprovalQueue((q) => [
          ...q,
          {
            askId: ev.askId!,
            cmd: String(ev.cmd),
            suggestedAllow: String(ev.suggestedAllow ?? ev.cmd),
            kind:
              ev.kind === "web_fetch" || ev.kind === "web_search" || ev.kind === "browser" || ev.kind === "delete_path"
                ? ev.kind
                : "command",
          },
        ]);
      });
    }
    if (ev.type === "done" || ev.type === "run_started") return;

    if (ev.type === "action") {
      flushCmdChunkNow();
      appendTurnEvent(
        ev.ts ? ev : { ...ev, ts: Date.now() },
        (x) => x.type === "action" && x.actionKey === ev.actionKey && x.iteration === ev.iteration
      );
      return;
    }

    if (ev.type === "command_chunk") {
      const iteration = Number(ev.iteration ?? 1);
      const stream = ev.stream === "stderr" ? "stderr" : "stdout";
      const piece = String(ev.text ?? "");
      if (!piece) return;
      const chunkText = stream === "stderr" ? `[stderr] ${piece}` : piece;
      const cur = cmdChunkPendingRef.current;
      if (cur && cur.turnId === turnId && cur.iteration === iteration) {
        cmdChunkPendingRef.current = { turnId, iteration, stream, text: cur.text + chunkText };
      } else {
        if (cur?.text) {
          if (cmdChunkRafRef.current != null) {
            cancelAnimationFrame(cmdChunkRafRef.current);
            cmdChunkRafRef.current = null;
          }
          applyCmdChunkPending(cur);
        }
        cmdChunkPendingRef.current = { turnId, iteration, stream, text: chunkText };
      }
      scheduleCmdChunkRaf();
      return;
    }

    startTransition(() => {
      let stamped: UIEvent = ev;
      if (ev.type === "thought" && stampedThoughtMs != null) {
        stamped = { ...ev, thoughtMs: stampedThoughtMs };
      }
      appendTurnEvent(
        stamped,
        ev.type === "iter_start"
          ? (x) => x.type === "iter_start" && x.iteration === (ev.iteration ?? 1)
          : ev.type === "observation"
            ? (x) =>
                x.type === "observation" &&
                x.iteration === ev.iteration &&
                (ev.actionKey ? x.actionKey === ev.actionKey : x.summary === ev.summary)
            : ev.type === "thought"
              ? (x) => x.type === "thought" && Number(x.iteration) === Number(ev.iteration ?? 1)
              : undefined,
      );
      if (ev.type === "observation" && ev.diffs && ev.diffs.length) onDiffs(ev.diffs);
    });
  }, [
    onDiffs,
    flushPendingTokensNow,
    flushCmdChunkNow,
    applyCmdChunkPending,
    scheduleCmdChunkRaf,
    scheduleTokenRaf,
    markThoughtStart,
    finalizeThoughtDuration,
    setContextUsage,
  ]);

  useEffect(() => {
    if (reconnectAttemptedRef.current) return;
    reconnectAttemptedRef.current = true;
    
    // Helper to connect to a running session
    const connectToSession = (backendSession: { id: string; task: string; mode: "ask" | "agent"; status: string; createdAt: number }) => {
      console.log("[Chat] Reconnecting to running session:", backendSession.id);
      setRunning(true);
      enableAutoScroll();
      stickToBottom();
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
            thinkingRef.current = null;
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
          thinkingRef.current = null;
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
          thinkingRef.current = null;
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

    // Visibility-aware backup poll: SSE already drives the live updates,
    // this 8s tick (paused while the tab is hidden) only catches the rare
    // case where the SSE channel got closed without a `done` frame landing.
    const interval = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void checkSessionStatus();
    }, 8000);
    return () => window.clearInterval(interval);
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

  function patchSession(fn: (s: ChatSession) => ChatSession) {
    const next = fn(sessionRef.current);
    sessionRef.current = next;
    onUpdate(next);
  }

  const runTask = useCallback(async (t: string) => {
    if (!t.trim() && attachedImages.length === 0) return;
    if (running) return;
    
    // Capture current images before clearing
    const refs = browserElementRefsRef.current;
    const images = [
      ...attachedImages.slice(),
      ...collectSelectElImages(t, refs),
    ];

    const priorTurns = sessionRef.current.turns.slice();
    const agentTask = composeAgentTaskWithHistory(priorTurns, expandSelectElsForAgent(t, refs));
    const runMode: ChatMode = sessionRef.current.mode ?? "agent";
    const turn: ChatTurn = {
      id: `t_${Date.now().toString(36)}`,
      task: t,
      mode: runMode,
      events: [],
      status: "running",
      startedAt: Date.now(),
      images: images.map((img) => ({ id: img.id, dataUrl: img.dataUrl, name: img.name })),
      selectElMeta: buildSelectElMeta(t, refs),
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
    enableAutoScroll();
    stickToBottom();
    setAwaitingStop(false);
    stoppedRef.current = false;
    const startedAt = Date.now();
    markThoughtStart(turn.id, 1);
    thinkingRef.current = { iteration: 1, partial: "", startedAt };
    setThinking(thinkingRef.current);

    try {
      // Start a background session - agent continues even if browser disconnects
      // Include images as base64 data
      const { session: backendSession } = await api.startSession(
        agentTask,
        runMode,
        images.map((img) => ({ dataUrl: img.dataUrl, name: img.name })),
        sessionRef.current.id,
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
      thinkingRef.current = null;
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
    const runFiles = cp.backupType === "run-files";
    const ok = await dlg.confirm({
      title: "Restore checkpoint",
      message: runFiles
        ? `Undo agent changes from this run?\n\n` +
          `Only files the agent edited in this chat turn will be reverted ` +
          `(snapshot from ${new Date(cp.createdAt).toLocaleString()}).`
        : `Restore workspace to "${cp.label}"?\n\n` +
          `This rewinds the working tree to the snapshot taken ` +
          `${new Date(cp.createdAt).toLocaleString()}. Untracked files added since ` +
          `then will be removed; ignored files (node_modules etc.) are kept.\n\n` +
          `A fresh "before restore" checkpoint is created first, so this is reversible.`,
      confirmLabel: "Restore",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.restoreCheckpoint(cp);
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

  // Modal "Always allow web" button: flips the per-workspace auto-allow toggle
  // for web_fetch / web_search / browser_* tools, then satisfies the current
  // ask. Same Settings flag, just reachable without leaving the modal.
  async function autoApproveWebFromModal(askId: string, editedCmd?: string) {
    try {
      await api.setAutoApproveWeb(true);
    } catch (err) {
      void dlg.alert(`Failed to enable auto-allow web tools: ${(err as Error).message}`);
      return;
    }
    void respondToApproval(askId, "allow_once", editedCmd);
  }

  async function autoApproveDeleteFromModal(askId: string, editedCmd?: string) {
    try {
      await api.setAutoApproveDelete(true);
    } catch (err) {
      void dlg.alert(`Failed to enable auto-allow deletes: ${(err as Error).message}`);
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

  const liveRunLabel = useMemo(() => {
    if (!running) return "";
    const last = session.turns[session.turns.length - 1];
    if (!last) return "";
    return deriveLiveActivity(last.events as UIEvent[], true)?.label ?? "";
  }, [running, session.turns]);

  const statusText =
    running && awaitingStop ? "● stopping…" :
    running && sessionConnecting ? "● connecting…" :
    running && liveRunLabel ? `● ${liveRunLabel}` :
    running ? "● running…" :
    status === "done" ? "● done" :
    status === "error" ? "● error" :
    status === "stopped" ? "● stopped" :
    "● ready";

  const [chatsBrowserOpen, setChatsBrowserOpen] = useState(false);
  const [contextPanelOpen, setContextPanelOpen] = useState(false);

  useEffect(() => {
    if (running || !workspace) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void fetchContextPreview({ session, taskDraft: task, mode }).then((usage) => {
        if (!cancelled && usage) setContextUsage(usage);
      });
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [session, task, mode, running, workspace, session.turns, session.updatedAt]);

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
        <div className="chat-status-main">
          {statusText}
          {!showSessionChrome && <span className="chat-status-title">{session.title}</span>}
        </div>
        <div className="chat-status-context-wrap">
          <ContextUsageTrigger
            estimate={contextUsage}
            open={contextPanelOpen}
            onToggle={() => setContextPanelOpen((v) => !v)}
          />
          {contextPanelOpen && (
            <ContextUsagePanel
              estimate={contextUsage}
              modelLabel={modelLabel ?? llmSettings?.MODEL}
              onClose={() => setContextPanelOpen(false)}
            />
          )}
        </div>
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
        {session.turns.length === 0 ? (
          <div className="chat-empty">
            <div className="chat-empty-title">How can I help?</div>
            <div className="chat-empty-sub">
              Ask anything — read code, write features, run tests, fix bugs.
            </div>
            <div className="chat-empty-tips">
              <kbd>Enter</kbd> send · <kbd>Shift+Enter</kbd> newline · <kbd>@</kbd> reference file · <kbd>Esc</kbd> stop
            </div>
          </div>
        ) : (
          <Virtuoso
            ref={virtuosoRef}
            className="chat-log"
            data={session.turns}
            initialTopMostItemIndex={session.turns.length - 1}
            scrollerRef={bindChatScroller}
            followOutput={() => (running && autoScrollRef.current ? "auto" : false)}
            atBottomThreshold={80}
            atBottomStateChange={(atBottom) => {
              if (atBottom) {
                if (atBottomDebounceRef.current != null) {
                  clearTimeout(atBottomDebounceRef.current);
                  atBottomDebounceRef.current = null;
                }
                autoScrollRef.current = true;
                setAutoScroll(true);
                return;
              }
              if (performance.now() < programmaticUntilRef.current) return;
              if (atBottomDebounceRef.current != null) clearTimeout(atBottomDebounceRef.current);
              atBottomDebounceRef.current = setTimeout(() => {
                atBottomDebounceRef.current = null;
                if (performance.now() < programmaticUntilRef.current) return;
                autoScrollRef.current = false;
                setAutoScroll(false);
              }, 140);
            }}
            components={{ Footer: () => <div style={{ height: 24 }} /> }}
            itemContent={(index, turn) => {
              const isLast = index === session.turns.length - 1;
              const isStreaming = isLast && running;
              return (
                <div className="chat-turn">
                  <UserMessage
                    task={turn.task}
                    selectElMeta={turn.selectElMeta}
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
                    settledReasoningMap={settledReasoning.get(turn.id)}
                    settledThoughtMap={settledThoughts.get(turn.id)}
                    settledThoughtDurationMap={settledThoughtDurations.get(turn.id)}
                    streamingThoughtStartedAt={isStreaming ? thinking?.startedAt : undefined}
                  />
                </div>
              );
            }}
          />
        )}
        {!autoScroll && session.turns.length > 0 && (
          <button
            type="button"
            className="scroll-bottom"
            aria-label="Scroll to latest messages"
            onClick={() => scrollToBottom()}
          >
            ↓ Latest
          </button>
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
          <div className={`composer-lower ${running ? "running-led" : ""}`} onPaste={handlePaste}>
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
              <ComposerEditable
                value={task}
                valueVersion={taskVersion}
                selectElRefs={browserElementRefsRef.current}
                selectElRefsVersion={selectElRefsVersion}
                onChange={handleComposerChange}
                onCommit={commitComposerValue}
                onRemoveSelectEl={(key) => {
                  browserElementRefsRef.current.delete(key);
                  setSelectElRefsVersion((v) => v + 1);
                }}
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
                    title={awaitingStop ? "Stopping…" : sessionConnecting ? "Connecting…" : "Thought…"}
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
        onAutoApproveWeb={(askId, editedCmd) => void autoApproveWebFromModal(askId, editedCmd)}
        onAutoApproveDelete={(askId, editedCmd) => void autoApproveDeleteFromModal(askId, editedCmd)}
      />
    </div>
  );
}

// ---- Composer subcomponents ------------------------------------------------

function ComposerHeader({
  mentions, images, running, awaitingStop, onStop,
  onRemoveMention, onRemoveImage,
}: {
  mentions: string[];
  images: { id: string; dataUrl: string; name: string }[];
  running: boolean;
  awaitingStop: boolean;
  onStop: () => void;
  onRemoveMention: (path: string) => void;
  onRemoveImage: (id: string) => void;
}) {
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
    const openAiShaped = s.LLM_PROVIDER !== "ollama";
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

/**
 * Tiny in-memory cache so reopening the model dropdown doesn't refetch the
 * upstream `/v1/models` list on every click. Keyed by the inputs that affect
 * the result (provider + base URL). Five-minute TTL is plenty for the rare
 * case where the provider adds a new model mid-session.
 */
const MODEL_LIST_TTL_MS = 5 * 60_000;
const modelListCache = new Map<string, { models: string[]; ts: number }>();
function modelListCacheKey(s: SettingsPayload): string {
  const base = (s.BASE_URL?.trim() || s.INTEGRATIONS?.[s.LLM_PROVIDER]?.defaultBaseUrl || "").trim();
  return `${s.LLM_PROVIDER}::${base}`;
}
async function fetchModelListCached(s: SettingsPayload, force = false): Promise<string[]> {
  const key = modelListCacheKey(s);
  const hit = modelListCache.get(key);
  if (!force && hit && Date.now() - hit.ts < MODEL_LIST_TTL_MS) return hit.models;
  const models = await fetchModelListForSettings(s);
  modelListCache.set(key, { models, ts: Date.now() });
  return models;
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
    // Serve cached results synchronously when fresh; only show the spinner
    // when we genuinely have to hit the network. This keeps reopening the
    // dropdown feeling instant.
    const cached = modelListCache.get(modelListCacheKey(settings));
    if (cached && Date.now() - cached.ts < MODEL_LIST_TTL_MS) {
      setList(cached.models);
      setLoading(false);
      return;
    }
    setLoading(true);
    void fetchModelListCached(settings).then((m) => {
      if (!cancelled) setList(m);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [open, settings]);

  function pick(m: string): void {
    if (!onModelChange) return;
    // Close the menu immediately and fire-and-forget the change. Awaiting
    // here used to block the click handler for two network roundtrips
    // (save + reload settings), making the dropdown feel frozen.
    setOpen(false);
    setSearch("");
    void Promise.resolve(onModelChange(m)).catch(() => { /* upstream surfaces errors */ });
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
