import { chat, chatStream, type ChatMessage, type ContentPart } from "../llm/client.js";
import { SYSTEM_PROMPT, ASK_SYSTEM_PROMPT, buildContextMessage, buildAskMessage, taskSignalsConsultationFirst } from "../llm/prompt.js";
import {
  SYSTEM_PROMPT_COMPACT,
  SYSTEM_PROMPT_MINIMAL,
  ASK_SYSTEM_PROMPT_COMPACT,
  ASK_SYSTEM_PROMPT_MINIMAL,
  buildContextMessageCompact,
  buildAskMessageCompact,
  selectPromptVersion,
  estimateTokens,
  clampUserMessageToInputBudget,
} from "../llm/prompt-compact.js";
import {
  normalizePromptMode,
  promptModeToContextTier,
  maxOutputTokensForMode,
} from "../llm/prompt-mode.js";
import { rankRelevant } from "../relevance/search.js";
import { buildCompactTree } from "../tools/file.js";
import { extractAllActions, parseAgentResponse, type AgentStep } from "./parser.js";
import { sanitizeFinalOrKeep } from "./sanitizeFinal.js";
import { executeTool, type ToolContext, type ToolOutcome } from "./executor.js";
import { createCheckpoint, type Checkpoint } from "../utils/checkpoints.js";
import { cancelAllForRun } from "../utils/approvals.js";
import { getWorkspace } from "../utils/workspace.js";
import { loadProjectRules } from "../utils/projectRules.js";

/** Per-iteration LLM call ceiling — without this, a stalled model/stream leaves the agent run open forever. */
function readLlmTimeoutMs(): number {
  const raw = process.env.LLM_TIMEOUT_MS;
  if (raw === undefined || raw === "") return 600_000; // 10 minutes default
  const n = Number(raw);
  return Number.isFinite(n) && n >= 15_000 ? n : 600_000;
}

function chatAbortSignal(user: AbortSignal | undefined): AbortSignal {
  const ms = readLlmTimeoutMs();
  const t = AbortSignal.timeout(ms);
  return user ? AbortSignal.any([user, t]) : t;
}

/**
 * Build user message content, optionally including images.
 * When images are present, returns an array of ContentParts; otherwise returns a plain string.
 */
function buildUserContent(
  text: string, 
  images?: { dataUrl: string; name: string }[]
): string | ContentPart[] {
  if (!images || images.length === 0) return text;
  
  const parts: ContentPart[] = [{ type: "text", text }];
  for (const img of images) {
    parts.push({ type: "image_url", image_url: { url: img.dataUrl } });
  }
  return parts;
}

export type AgentMode = "ask" | "agent";

export type AgentEvent =
  | { type: "log"; level: "info" | "warn" | "error"; message: string }
  | { type: "iter_start"; iteration: number }
  | { type: "token"; iteration: number; delta: string }
  | { type: "thought"; iteration: number; thought: string }
  | { type: "tool_payload_streaming"; iteration: number; tool: string }
  | { type: "action"; iteration: number; tool: string; input: Record<string, unknown>; actionKey?: string }
  /** Write tool finished touching disk (before observation, which waits for end of streamed assistant message). */
  | { type: "tool_disk_settled"; iteration: number; actionKey: string; ok: boolean }
  /** Live stdout/stderr while run_command child is running (event-driven stream; no poll loop). */
  | { type: "command_chunk"; iteration: number; stream: "stdout" | "stderr"; text: string }
  | { type: "observation"; iteration: number; ok: boolean; summary: string; diffs?: string[] }
  | { type: "final"; result: string }
  | { type: "error"; message: string }
  | { type: "aborted"; message: string }
  // Safety net: snapshot taken before any agent edit, surfaced so the UI
  // can render a "↶ Restore" button on the assistant turn.
  | { type: "checkpoint"; checkpoint: Checkpoint }
  // Policy gate: command needs the user's blessing before it runs.
  | { type: "policy_ask"; askId: string; cmd: string; suggestedAllow: string }
  // Outcome of the policy gate, including auto-allow / hard-deny outcomes.
  | { type: "policy_decision"; decision: "allow_once" | "allow_always" | "allow_auto" | "deny";
      cmd: string; originalCmd?: string; matched?: string; reason?: string };

export interface AgentRunOptions {
  task: string;
  mode?: AgentMode;
  onEvent?: (e: AgentEvent) => void;
  signal?: AbortSignal;
  /** Stable id for this run — used to scope pending approvals so an abort cleans them up. */
  runId?: string;
  /** Attached images (base64 data URLs) */
  images?: { dataUrl: string; name: string }[];
}

export interface AgentRunResult {
  result: string;
  iterations: number;
  diffs: string[];
  events: AgentEvent[];
  /** Pre-run checkpoint, if one was successfully taken. */
  checkpoint?: Checkpoint;
}

/**
 * Detect whether a FINAL message is "secretly a file in disguise" — i.e. it
 * carries one or more fenced code blocks with enough lines to be a real
 * source file rather than a quick snippet. Threshold is intentionally
 * lenient: even ~6 lines of Python is a clear "I made you a file" signal.
 */
/**
 * Heuristic: does the user's task imply a "scaffold a project" deliverable
 * that any reasonable engineer would split across several files?
 *
 * We err on the side of *not* triggering — only obvious "build me an X"
 * phrasings count, so single-file requests like "fix this bug" or
 * "write a sort function in foo.py" don't get harassed by the guardrail.
 */
/**
 * True when the model's own FINAL response is asking the user questions or
 * presenting options that need confirmation before proceeding.
 * Used to skip all nudge guards so the agent doesn't override a legitimate
 * consultation response and keep running autonomously.
 */
function finalContainsConsultation(result: string): boolean {
  const r = result.trim();
  const questionCount = (r.match(/\?/g) || []).length;
  // Two or more question marks = clearly asking the user something.
  if (questionCount >= 2) return true;
  // Numbered list of items + at least one "?" — classic "here are my questions" format.
  if (/^\s*\d+\./m.test(r) && questionCount >= 1) return true;
  // Vietnamese explicit consultation signals.
  if (/(xác\s*nhận|bạn\s+muốn|bạn\s+có\s+muốn|bạn\s+chọn|câu\s+hỏi|tôi\s+cần\s+biết|hỏi\s+bạn|cần\s+bạn\s+xác\s*nhận)/i.test(r)) return true;
  // English confirmation/selection prompts.
  if (/(please\s+(confirm|clarify|choose|select)|let\s+me\s+know\s+(which|if|whether)|which\s+(option|approach)\s+do\s+you|do\s+you\s+want\s+me\s+to)/i.test(r)) return true;
  return false;
}

function looksLikeScaffoldTask(task: string): boolean {
  const t = task.toLowerCase();
  const verbs =
    /\b(build|create|make|scaffold|generate|write|develop|design|code|xay|xaay|xây|tao|tạo|viet|viết|làm|lam)\b/;
  const subjects =
    /\b(web ?site|web ?app|webapp|landing( page)?|portfolio|blog|store|shop|dashboard|admin panel|spa|app|application|game|platform|saas|crud|todo app|chat app|booking|delivery|ecommerce|e-?commerce|marketplace|cms|forum|wiki|trang web|website|ứng ?dụng|ung ?dung)\b/;
  return verbs.test(t) && subjects.test(t);
}

function hasSubstantialCodeBlock(text: string): boolean {
  const fence = /```[a-zA-Z0-9_+-]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) {
    const body = m[1].trim();
    if (!body) continue;
    const lines = body.split("\n").length;
    if (lines >= 5) return true;
    // Or at least one "code-like" signal in a short block.
    if (/(?:^|\n)\s*(?:def |class |import |function |const |let |export |#include|package )/.test(body)) {
      return true;
    }
  }
  return false;
}

/** THOUGHT names concrete paths / edits — model often still skips ACTION. */
function thoughtPromisesConcreteWork(thought: string): boolean {
  const t = thought.trim();
  if (t.length < 35) return false;
  const pathOrExt =
    /[`'][^`'\\]+\.[a-zA-Z0-9]{1,8}[`'"]|\.(?:html?|tsx?|jsx?|css|vue|svelte|py|rs|go|java|ts|js)\b/i;
  const editVerb =
    /\b(will|going to|need to|must|should|fix|edit|patch|write|add|implement|complete|render|sửa|sua|viết|viet|thêm|them|hoàn|hoan|tạo|tao|nâng\s*cấp|nang\s*cap|tối\s*ưu|toi\s*uu|cải\s*thiện|cai\s*thien|nâng\s*lên|nang\s*len|tối\s*ưu\s*hóa|toi\s*uu\s*hoa)\b/i;
  return pathOrExt.test(t) && editVerb.test(t);
}

/** FINAL is a no-op platitude (common model failure mode with THOUGHT + FINAL, no ACTION). */
function looksLikeNoOpFinal(result: string): boolean {
  const r = result.trim();
  if (r.length > 220) return false;
  if (hasSubstantialCodeBlock(r)) return false;
  const plat =
    /^(task\s+completed\.?|done\.?|finished\.?|complete\.?|completed\.?|success\.?|ok\.?|hoàn\s+tất\.?|xong\.?)$/i;
  if (plat.test(r)) return true;
  const words = r.split(/\s+/).filter(Boolean).length;
  // Short, no path-like token — likely hand-waving (avoid nudging real "Fixed `x`." summaries).
  if (
    r.length <= 52 &&
    words <= 6 &&
    !/`/.test(r) &&
    !/\b[\w/-]+\.[a-zA-Z0-9]{1,6}\b/.test(r)
  ) {
    return true;
  }
  return false;
}

/**
 * Best-effort guess of a filename for the lazy-final nudge. Looks at:
 *   1. an explicit hint in the user's task ("save to X", "in `foo.py`")
 *   2. the language tag of the first fenced block (```python → .py)
 *   3. obvious markers in the code body itself (e.g. `class LoginWindow`)
 */
function guessFilenameFor(task: string, finalText: string): string | null {
  // Explicit user hint
  const explicit = /(?:in|to|at|as)\s+`?([\w./-]+\.[a-zA-Z0-9]+)`?/i.exec(task);
  if (explicit) return explicit[1];

  const fence = /```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/.exec(finalText);
  const lang = (fence?.[1] ?? "").toLowerCase();
  const body = fence?.[2] ?? "";

  // Pick a stem: the first interesting symbol name, or "main".
  const symbol =
    /class\s+([A-Z][\w]*)/.exec(body)?.[1] ??
    /def\s+([a-zA-Z_][\w]*)/.exec(body)?.[1] ??
    /function\s+([a-zA-Z_$][\w$]*)/.exec(body)?.[1] ??
    null;
  const stem = (symbol ?? "main").replace(/([A-Z])/g, "_$1").replace(/^_/, "").toLowerCase();

  const ext: Record<string, string> = {
    python: "py", py: "py",
    typescript: "ts", ts: "ts",
    javascript: "js", js: "js",
    tsx: "tsx", jsx: "jsx",
    go: "go", rust: "rs", rs: "rs",
    java: "java", c: "c", cpp: "cpp", "c++": "cpp",
    rb: "rb", ruby: "rb", php: "php", sh: "sh", bash: "sh",
    html: "html", css: "css", json: "json", yaml: "yaml", yml: "yml",
    sql: "sql", md: "md",
  };
  const e = ext[lang];
  if (!e) return null;

  // Prefer a `scripts/` folder for runnable single-file scripts in scripty
  // languages so we don't pollute the workspace root.
  const inScriptsDir = ["py", "sh", "rb", "js"].includes(e);
  return `${inScriptsDir ? "scripts/" : ""}${stem}.${e}`;
}

/** Tools that mutate the workspace — we resolve these early to update didWrite before guardrails. */
function isWriteTool(type: string): boolean {
  return type === "write_patch" || type === "create_file";
}

/** Compare write-tool inputs without fragile JSON.stringify (key order, normalization). */
function sameWriteToolInput(
  a: { type: string; input: Record<string, unknown> },
  b: { type: string; input: Record<string, unknown> },
): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "create_file") {
    return (
      String(a.input.path ?? "") === String(b.input.path ?? "") &&
      String(a.input.content ?? "") === String(b.input.content ?? "")
    );
  }
  if (a.type === "write_patch") {
    return (
      String(a.input.patches ?? a.input.patch ?? "") === String(b.input.patches ?? b.input.patch ?? "")
    );
  }
  return false;
}

/** True when parsed step is exactly one tool call matching the early-stream ACTION (not parallel multi-tool). */
function actionsMatchEarly(
  step: AgentStep,
  early: { type: string; input: Record<string, unknown> },
): boolean {
  if (step.kind === "action") {
    if (isWriteTool(step.type) && isWriteTool(early.type)) {
      return sameWriteToolInput(step, early);
    }
    return step.type === early.type && JSON.stringify(step.input) === JSON.stringify(early.input);
  }
  if (step.kind === "multi_action") {
    if (step.actions.length !== 1) return false;
    const sa = step.actions[0];
    if (isWriteTool(sa.type) && isWriteTool(early.type)) {
      return sameWriteToolInput(sa, early);
    }
    return sa.type === early.type && JSON.stringify(sa.input) === JSON.stringify(early.input);
  }
  return false;
}

function actionScheduleKey(type: string, input: Record<string, unknown>): string {
  return `${type}:${JSON.stringify(input)}`;
}

type EarlyToolExec = {
  type: string;
  input: Record<string, unknown>;
  promise: Promise<ToolOutcome>;
  outcome?: ToolOutcome;
  /** True once we've emitted a per-tool `observation` for this entry. The
   *  iteration-level aggregator skips these so diffs aren't double-counted
   *  in the chat trace and on the diff sidebar. */
  streamedObservation?: boolean;
};

function detectStreamingToolPayload(buf: string): { tool: string } | null {
  const markerMatch = /(?:^|\n)ACTION:\s*/i.exec(buf);
  if (!markerMatch) return null;
  let after = buf.slice(markerMatch.index + markerMatch[0].length).trimStart();
  if (/^```(?:json)?\s*\n?/i.test(after)) {
    after = after.replace(/^```(?:json)?\s*\n?/i, "");
  }
  const jsonStart = after.indexOf("{");
  if (jsonStart === -1) return null;
  const head = after.slice(jsonStart, jsonStart + 16_000);
  const m = /"type"\s*:\s*"([^"]+)"/.exec(head);
  if (!m) return null;
  const tool = m[1];
  if (tool === "write_patch" || tool === "create_file") return { tool };
  return null;
}

export async function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  const events: AgentEvent[] = [];
  const emit = (e: AgentEvent) => {
    events.push(e);
    try { opts.onEvent?.(e); } catch { /* noop */ }
  };

  const wsRoot = getWorkspace();
  const loadedRules = loadProjectRules(wsRoot);
  const projectRulesBlock =
    loadedRules.text.length > 0
      ? `\n\n---\nPROJECT RULES (this workspace — follow over generic defaults):\n${loadedRules.text}`
      : "";
  if (loadedRules.relPaths.length > 0) {
    emit({
      type: "log",
      level: "info",
      message: `Project rules: ${loadedRules.relPaths.length} file(s) from .pig/rules and/or .cursor/rules`,
    });
    if (loadedRules.truncated) {
      emit({
        type: "log",
        level: "warn",
        message: "Project rules exceeded PROJECT_RULES_MAX_CHARS; rest omitted. Raise the limit in server env if needed.",
      });
    }
  }

  const mode: AgentMode = opts.mode === "ask" ? "ask" : "agent";
  // 50 iterations covers most complex multi-file projects. User can raise further in Settings.
  const maxIter = Math.max(1, Number(process.env.MAX_ITERATIONS || 50));
  const maxFiles = Math.max(1, Number(process.env.MAX_CONTEXT_FILES || 5));
  const relevant = await rankRelevant(opts.task, maxFiles);
  // Build once; embedded in every context message so agent doesn't need codebase_map for orientation.
  const compactTree = await buildCompactTree(3, 180).catch(() => "");

  // History uses simple string content (images only go in the initial user message, not history)
  const history: { role: "system" | "user" | "assistant"; content: string }[] = [];
  const diffs: string[] = [];
  let finalResult = "";

  const checkAbort = () => {
    if (opts.signal?.aborted) {
      emit({ type: "aborted", message: "Agent aborted by user" });
      // Free any approval Promises this run is blocking on so the executor
      // throws cleanly instead of leaking timers.
      if (opts.runId) cancelAllForRun(opts.runId, "agent aborted");
      throw new Error("aborted");
    }
  };

  // ---------- ASK MODE: single LLM call, plain markdown reply, no tools ----------
  if (mode === "ask") {
    checkAbort();
    emit({ type: "iter_start", iteration: 1 });
    
    const promptMode = normalizePromptMode(process.env.PROMPT_MODE);
    const askTier = promptModeToContextTier(promptMode);
    let systemPrompt: string;
    let userMsg: string;
    if (promptMode === "verbose") {
      systemPrompt = ASK_SYSTEM_PROMPT + projectRulesBlock;
      userMsg = buildAskMessage(opts.task, relevant, history);
    } else {
      systemPrompt =
        (promptMode === "minimal" ? ASK_SYSTEM_PROMPT_MINIMAL : ASK_SYSTEM_PROMPT_COMPACT) + projectRulesBlock;
      userMsg = buildAskMessageCompact(opts.task, relevant, history, askTier);
    }
    const umBefore = userMsg.length;
    userMsg = clampUserMessageToInputBudget(systemPrompt, userMsg);
    if (userMsg.length < umBefore - 40) {
      emit({ type: "log", level: "info", message: `Context trimmed for LLM budget (${umBefore}→${userMsg.length} chars)` });
    }

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: buildUserContent(userMsg, opts.images) },
    ];
    let raw: string;
    try {
      raw = await chat(messages, {
        signal: chatAbortSignal(opts.signal),
        maxTokens: maxOutputTokensForMode(promptMode),
        onToken: (delta) => emit({ type: "token", iteration: 1, delta }),
      });
    } catch (err) {
      if (opts.signal?.aborted) {
        emit({ type: "aborted", message: "Aborted by user" });
        return { result: "aborted", iterations: 1, diffs, events };
      }
      const msg =
        err instanceof Error && err.name === "AbortError"
          ? `LLM timed out after ${readLlmTimeoutMs()}ms (raise LLM_TIMEOUT_MS on the server if needed).`
          : err instanceof Error
            ? err.message
            : String(err);
      emit({ type: "error", message: msg });
      const wrapped = new Error(msg);
      (wrapped as Error & { __emitted?: boolean }).__emitted = true;
      throw wrapped;
    }
    finalResult = sanitizeFinalOrKeep(raw.trim());
    emit({ type: "final", result: finalResult });
    return { result: finalResult, iterations: 1, diffs, events };
  }

  // ---------- AGENT MODE: full ReAct loop with tools ----------

  // Safety net: snapshot the workspace BEFORE the agent starts touching it.
  // Uses git-based checkpoints if available, otherwise file-based backup.
  const runId = opts.runId ?? `run-${Date.now().toString(36)}`;
  let preRunCheckpoint: Checkpoint | null = null;
  try {
    preRunCheckpoint = await createCheckpoint(`Before: ${opts.task.slice(0, 80)}`, {
      runId,
      kind: "auto-pre-run",
    });
    if (preRunCheckpoint) {
      emit({ type: "checkpoint", checkpoint: preRunCheckpoint });
    } else {
      emit({ type: "log", level: "warn", message: "Unable to create checkpoint." });
    }
  } catch (err) {
    emit({ type: "log", level: "warn", message: `Checkpoint failed: ${(err as Error).message}` });
  }

  /**
   * Track whether the model has actually written anything to disk this run.
   * If it tries to "answer with code" via FINAL without ever calling
   * write_patch, we'll bounce it back once and demand a real patch — this is
   * the #1 way the model fakes being agentic.
   */
  let didWrite = false;
  /** Count of distinct write_patch ACTIONS that produced diffs this run. */
  let writeCount = 0;
  /** Don't bounce more than once per run, otherwise we'd loop forever. */
  let nudgeUsed = false;
  /** THOUGHT promises work but model emitted FINAL without tools — separate from lazy-code FINAL. */
  let prematureFinalNudgeUsed = false;
  /** Same idea for the scaffold-too-shallow guardrail. */
  let scaffoldNudgeUsed = false;
  const scaffoldExpected = looksLikeScaffoldTask(opts.task);

  /** Stuck detection: consecutive parse errors */
  let consecutiveParseErrors = 0;
  const MAX_CONSECUTIVE_PARSE_ERRORS = 3;
  
  /** Stuck detection: repeated identical actions */
  let lastActionSignature = "";
  let sameActionCount = 0;
  /** Stop sooner on identical tool inputs (often run_command retry loops wasting tokens). */
  const MAX_SAME_ACTION_REPEAT = 3;

  // Tool context — passed to every executeTool() call so `run_command` can
  // emit policy events and bridge approvals back through the SSE channel.
  const toolCtx: ToolContext = {
    runId,
    /** Current ReAct iteration — run_command streams tag with this for the UI. */
    iteration: 0,
    emit: (e: { type: string; [k: string]: unknown }) => emit(e as AgentEvent),
    /** Cache file reads for the duration of this run to avoid duplicate token waste. */
    readCache: new Map(),
  };

  const promptMode = normalizePromptMode(process.env.PROMPT_MODE);
  const contextTier = promptModeToContextTier(promptMode);

  for (let i = 1; i <= maxIter; i++) {
    toolCtx.iteration = i;
    checkAbort();
    
    let systemPrompt: string;
    let userMsg: string;

    if (promptMode === "verbose") {
      systemPrompt = SYSTEM_PROMPT + projectRulesBlock;
      userMsg = buildContextMessage(opts.task, relevant, history, compactTree);
    } else {
      let version: "minimal" | "compact";
      if (promptMode === "minimal" || promptMode === "economical") {
        version = "minimal";
      } else if (promptMode === "detailed") {
        version = "compact";
      } else {
        version = selectPromptVersion(opts.task, history.length);
      }
      systemPrompt =
        (version === "minimal" ? SYSTEM_PROMPT_MINIMAL : SYSTEM_PROMPT_COMPACT) + projectRulesBlock;
      userMsg = buildContextMessageCompact(opts.task, relevant, history, contextTier, compactTree);
    }

    const umBefore = userMsg.length;
    userMsg = clampUserMessageToInputBudget(systemPrompt, userMsg);
    if (userMsg.length < umBefore - 40) {
      emit({ type: "log", level: "info", message: `Context trimmed for LLM budget (${umBefore}→${userMsg.length} chars)` });
    }

    // Only include images in the first iteration
    const userContent = i === 1 ? buildUserContent(userMsg, opts.images) : userMsg;
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ];

    emit({ type: "iter_start", iteration: i });

    // These are declared per-iteration so each loop pass starts clean.
    let raw = "";
    /** ACTION JSON objects that became complete mid-stream — each tool runs without waiting for later ACTION blocks. */
    const earlyScheduled = new Map<string, EarlyToolExec>();
    let streamingPayloadHintEmitted = false;

    try {
      for await (const delta of chatStream(messages, {
        signal: chatAbortSignal(opts.signal),
        maxTokens: maxOutputTokensForMode(promptMode),
      })) {
        raw += delta;
        emit({ type: "token", iteration: i, delta });
        // Large write_patch/create_file JSON may stream for a long time; surface a trace row (tool_payload_streaming).
        if (earlyScheduled.size === 0 && !streamingPayloadHintEmitted) {
          const streamingTool = detectStreamingToolPayload(raw);
          if (streamingTool) {
            streamingPayloadHintEmitted = true;
            emit({ type: "tool_payload_streaming", iteration: i, tool: streamingTool.tool });
          }
        }
        // Every complete ACTION: {...} in the buffer so far — fire new ones as each closes (true parallel multi-file).
        const completeActions = extractAllActions(raw);
        for (const act of completeActions) {
          const key = actionScheduleKey(act.type, act.input);
          if (earlyScheduled.has(key)) continue;
          // Reserve the slot synchronously so the per-tool observation hook
          // below can flip the `streamedObservation` flag on the same entry.
          const entryRef: EarlyToolExec = {
            type: act.type,
            input: act.input,
            promise: Promise.resolve(undefined as unknown as ToolOutcome),
          };
          earlyScheduled.set(key, entryRef);
          const promise = executeTool(act.type, act.input, toolCtx).then((outcome) => {
            if (isWriteTool(act.type)) {
              emit({ type: "tool_disk_settled", iteration: i, actionKey: key, ok: outcome.ok });
              // Stream a per-file observation as soon as the disk write
              // settles. This unblocks the diff sidebar — when the model
              // dispatches 5 create_file calls in a single turn the user
              // sees each file appear in the diff list immediately instead
              // of waiting for all 5 to finish + the iteration to wrap up.
              if (outcome.diffs?.length) {
                entryRef.streamedObservation = true;
                emit({
                  type: "observation",
                  iteration: i,
                  ok: outcome.ok,
                  summary: outcome.summary,
                  diffs: outcome.diffs,
                });
              }
            }
            return outcome;
          });
          entryRef.promise = promise;
          emit({ type: "action", iteration: i, tool: act.type, input: act.input, actionKey: key });
        }
      }
    } catch (err) {
      // Clean up any in-flight early execution before surfacing the error.
      await Promise.all([...earlyScheduled.values()].map((e) => e.promise.catch(() => {})));
      if (opts.signal?.aborted) {
        emit({ type: "aborted", message: "Agent aborted by user" });
        return { result: "aborted", iterations: i, diffs, events };
      }
      const msg =
        err instanceof Error && err.name === "AbortError"
          ? `LLM timed out after ${readLlmTimeoutMs()}ms (raise LLM_TIMEOUT_MS on the server if needed).`
          : err instanceof Error
            ? err.message
            : String(err);
      // Single source of truth for the error event; the route layer will not duplicate it.
      emit({ type: "error", message: msg });
      const wrapped = new Error(msg);
      (wrapped as Error & { __emitted?: boolean }).__emitted = true;
      throw wrapped;
    }

    // Resolve every tool that started streaming so guardrails see real writes before FINAL checks.
    await Promise.all(
      [...earlyScheduled.values()].map((e) =>
        e.promise
          .then((o) => {
            e.outcome = o;
          })
          .catch((err: Error) => {
            e.outcome = { ok: false, summary: `Tool error: ${err.message}`, diffs: [] as string[] };
          }),
      ),
    );
    for (const e of earlyScheduled.values()) {
      if (!isWriteTool(e.type)) continue;
      const o = e.outcome!;
      if (o.diffs?.length) {
        didWrite = true;
        writeCount += o.diffs.length;
        diffs.push(...o.diffs);
      }
    }

    const step = parseAgentResponse(raw);
    if (step.kind === "error") {
      consecutiveParseErrors++;
      emit({ type: "log", level: "warn", message: `Parse error (${consecutiveParseErrors}/${MAX_CONSECUTIVE_PARSE_ERRORS}): ${step.error}` });
      
      // After too many consecutive parse errors, the model probably can't follow ReAct format
      if (consecutiveParseErrors >= MAX_CONSECUTIVE_PARSE_ERRORS) {
        const bailMessage = 
          `Agent stopped: Model returned ${consecutiveParseErrors} consecutive unparseable responses. ` +
          `This usually means the model doesn't follow the ReAct (THOUGHT/ACTION/FINAL) format well.\n\n` +
          `**Suggestions:**\n` +
          `• Try a larger/smarter model (GPT-4o, Claude, Qwen 32B+)\n` +
          `• Use "Ask" mode instead of "Agent" for simple questions\n` +
          `• Break your request into smaller, clearer steps\n\n` +
          `Last model output:\n\`\`\`\n${raw.slice(0, 500)}${raw.length > 500 ? '...' : ''}\n\`\`\``;
        emit({ type: "log", level: "error", message: `Bailing out after ${consecutiveParseErrors} consecutive parse errors` });
        emit({ type: "final", result: bailMessage });
        return { result: bailMessage, iterations: i, diffs, events, checkpoint: preRunCheckpoint ?? undefined };
      }
      
      history.push({ role: "assistant", content: raw });
      history.push({ role: "user", content: `Your previous response could not be parsed (${step.error}). Re-emit using the strict ReAct format.` });
      continue;
    }
    
    // Reset parse error counter on successful parse
    consecutiveParseErrors = 0;

    // THOUGHT guard: if model emitted ACTION without THOUGHT, note it so we can
    // append a nudge to the observation message for the next iteration. We do NOT
    // cancel the early-scheduled tools or skip the observation — that would lose
    // real tool results and leave the UI stuck on "reading…" forever.
    const missingThought =
      !step.thought.trim() && (step.kind === "action" || step.kind === "multi_action");
    if (missingThought) {
      emit({ type: "log", level: "warn", message: "Missing THOUGHT — nudging model to include reasoning in next turn." });
    }

    if (step.thought) emit({ type: "thought", iteration: i, thought: step.thought });

    // Write tools finish on disk as soon as each ACTION JSON closes, but the model may
    // still be streaming THOUGHT/FINAL. Emit observation immediately once we know this
    // turn won't batch with other tools so the UI doesn't sit on "saving…" for minutes.
    let iterationObservationEmitted = false;
    let loneEarlyWrite: EarlyToolExec | null = null;
    if (earlyScheduled.size === 1) {
      const only = [...earlyScheduled.values()][0];
      if (isWriteTool(only.type) && only.outcome) loneEarlyWrite = only;
    }
    if (
      loneEarlyWrite?.outcome &&
      (step.kind === "final" || actionsMatchEarly(step, { type: loneEarlyWrite.type, input: loneEarlyWrite.input }))
    ) {
      // Per-tool observation may have already streamed mid-iteration with the
      // diffs payload; in that case still mark the iteration as observed but
      // avoid emitting a second observation event (prevents duplicate trace
      // rows + duplicate diff entries on the sidebar).
      if (!loneEarlyWrite.streamedObservation) {
        emit({
          type: "observation",
          iteration: i,
          ok: loneEarlyWrite.outcome.ok,
          summary: loneEarlyWrite.outcome.summary,
          diffs: loneEarlyWrite.outcome.diffs,
        });
      }
      iterationObservationEmitted = true;
    }

    if (step.kind === "final") {
      // If the model's FINAL is itself a consultation — asking the user questions /
      // presenting options that need confirmation — accept it immediately without
      // fighting it with premature / lazy / scaffold nudges.
      if (finalContainsConsultation(step.result)) {
        finalResult = sanitizeFinalOrKeep(step.result);
        if (!iterationObservationEmitted && earlyScheduled.size > 0) {
          const list = [...earlyScheduled.values()];
          const allOk = list.every((e) => e.outcome?.ok !== false);
          const summary = list.length === 1
            ? list[0].outcome!.summary
            : list.map((e) => `[${e.type}]: ${e.outcome!.summary}`).join("\n\n");
          // Skip diffs already streamed per-tool to prevent the sidebar from
          // showing duplicate hunks for the same file.
          const ds = list.flatMap((e) => (e.streamedObservation ? [] : e.outcome?.diffs ?? []));
          emit({ type: "observation", iteration: i, ok: allOk, summary, diffs: ds });
        }
        emit({ type: "final", result: finalResult });
        return { result: finalResult, iterations: i, diffs, events, checkpoint: preRunCheckpoint ?? undefined };
      }

      // Owner asked for a plan / discussion before work — accept FINAL without
      // tools on iteration 1 (do not fight with premature / lazy / scaffold nudges).
      if (
        !didWrite &&
        taskSignalsConsultationFirst(opts.task) &&
        i === 1 &&
        step.result.trim().length >= 60
      ) {
        finalResult = sanitizeFinalOrKeep(step.result);
        emit({ type: "final", result: finalResult });
        return { result: finalResult, iterations: i, diffs, events };
      }

      // Premature FINAL: THOUGHT describes real file work but zero tools ran.
      // (Otherwise models emit "Task completed." with no ACTION — lazy-final
      // guard only catches FINAL that still contain fenced code.)
      if (
        !didWrite &&
        !prematureFinalNudgeUsed &&
        !hasSubstantialCodeBlock(step.result) &&
        thoughtPromisesConcreteWork(step.thought) &&
        looksLikeNoOpFinal(step.result)
      ) {
        prematureFinalNudgeUsed = true;
        const nudge =
          `You emitted FINAL without running any ACTION this turn, but your THOUGHT described concrete file edits. ` +
          `In agent mode nothing is saved until you call tools. ` +
          `Emit an ACTION next: use read_file if needed, then write_patch (or run_command) — do NOT reply with FINAL alone until the edits exist on disk.`;
        emit({ type: "log", level: "warn", message: "Premature FINAL (no tools) — re-prompting agent." });
        history.push({ role: "assistant", content: raw });
        history.push({ role: "user", content: nudge });
        continue;
      }

      // Lazy-final guardrail: in agent mode, if the model "finishes" with a
      // substantial code block but never wrote a single patch, it almost
      // certainly meant to create a file and is just being lazy. Bounce it
      // back once, demanding a real write_patch.
      if (!didWrite && !nudgeUsed && hasSubstantialCodeBlock(step.result)) {
        nudgeUsed = true;
        const guess = guessFilenameFor(opts.task, step.result);
        const where = guess ? `\`${guess}\`` : "an appropriate path you choose";
        const nudge =
          `You ended with FINAL containing code, but you never called write_patch — so nothing was actually saved to disk. ` +
          `In agent mode, the user expects a real file. ` +
          `Please re-emit a write_patch ACTION that writes that code to ${where} (use empty SEARCH for a new file), then FINAL with a short summary.`;
        emit({ type: "log", level: "warn", message: "Lazy FINAL detected — re-prompting agent to write the file." });
        history.push({ role: "assistant", content: raw });
        history.push({ role: "user", content: nudge });
        continue;
      }
      // Shallow-scaffold guardrail: if the user clearly asked for a project
      // (web app, dashboard, store, etc.) and the model FINALs after only
      // 0-1 files were written, it almost certainly crammed everything into
      // one file or only made the index page. Bounce it ONCE to keep going.
      if (scaffoldExpected && !scaffoldNudgeUsed && writeCount <= 1) {
        scaffoldNudgeUsed = true;
        const nudge =
          `Your task ("${opts.task.slice(0, 120)}") is a multi-file project, but you only wrote ${writeCount} file(s) before FINAL. ` +
          `That's not a real deliverable — at minimum a website needs separate HTML page(s), a dedicated CSS file, a JS file, ` +
          `and a README. Please continue: list the remaining files in your next THOUGHT, then write_patch them one by one. ` +
          `Do NOT emit FINAL again until the project is meaningfully complete.`;
        emit({
          type: "log", level: "warn",
          message: `Shallow scaffold detected (${writeCount} file written) — re-prompting agent to keep building.`,
        });
        history.push({ role: "assistant", content: raw });
        history.push({ role: "user", content: nudge });
        continue;
      }
      finalResult = sanitizeFinalOrKeep(step.result);
      // ACTION(s) + FINAL in the same assistant message — append OBSERVATION to history if tools ran.
      if (earlyScheduled.size > 0) {
        if (!iterationObservationEmitted) {
          const list = [...earlyScheduled.values()];
          const allOkEarly = list.every((e) => e.outcome?.ok !== false);
          const summaryEarly =
            list.length === 1
              ? list[0].outcome!.summary
              : list.map((e) => `[${e.type}]: ${e.outcome!.summary}`).join("\n\n");
          // Skip diffs that already streamed per-tool to avoid duplicates.
          const diffsEarly = list.flatMap((e) => (e.streamedObservation ? [] : e.outcome?.diffs ?? []));
          emit({
            type: "observation",
            iteration: i,
            ok: allOkEarly,
            summary: summaryEarly,
            diffs: diffsEarly,
          });
        }
        history.push({ role: "assistant", content: raw });
        const listForHist = [...earlyScheduled.values()];
        const allOkHist = listForHist.every((e) => e.outcome?.ok !== false);
        const summaryHist =
          listForHist.length === 1
            ? listForHist[0].outcome!.summary
            : listForHist.map((e) => `[${e.type}]: ${e.outcome!.summary}`).join("\n\n");
        history.push({ role: "user", content: `OBSERVATION (iter ${i}, ok=${allOkHist}):\n${summaryHist}` });
      }
      emit({ type: "final", result: finalResult });
      return { result: finalResult, iterations: i, diffs, events };
    }

    // Determine the set of actions to execute (single or parallel multi-action).
    const stepActions: Array<{ type: string; input: Record<string, unknown> }> =
      step.kind === "multi_action"
        ? step.actions
        : step.kind === "action"
          ? [{ type: step.type, input: step.input }]
          : [];

    // Stuck detection — use a combined signature across all actions.
    const actionSignature = stepActions.map(a => `${a.type}:${JSON.stringify(a.input)}`).join("|");
    if (actionSignature === lastActionSignature) {
      sameActionCount++;
      if (sameActionCount >= MAX_SAME_ACTION_REPEAT) {
        const bailMessage = 
          `Agent stopped: Same action(s) repeated ${sameActionCount} times in a row.\n\n` +
          `**Action:** \`${stepActions[0]?.type ?? "unknown"}\`\n` +
          `**Input:** \`${JSON.stringify(stepActions[0]?.input ?? {}).slice(0, 200)}\`\n\n` +
          `This usually means the model is stuck in a loop. Try:\n` +
          `• Rephrasing your request more clearly\n` +
          `• Using a different/larger model\n` +
          `• Breaking the task into smaller steps`;
        emit({ type: "log", level: "error", message: `Stuck loop detected: action ${stepActions[0]?.type} repeated ${sameActionCount}x` });
        emit({ type: "final", result: bailMessage });
        return { result: bailMessage, iterations: i, diffs, events, checkpoint: preRunCheckpoint ?? undefined };
      }
    } else {
      lastActionSignature = actionSignature;
      sameActionCount = 1;
    }

    // Build execution promises — reuse mid-stream runs so tools never execute twice.
    const outcomePromises: Promise<ToolOutcome>[] = stepActions.map((act) => {
      const key = actionScheduleKey(act.type, act.input);
      const entry = earlyScheduled.get(key);
      if (entry?.outcome) return Promise.resolve(entry.outcome);
      if (entry) return entry.promise;
      emit({ type: "action", iteration: i, tool: act.type, input: act.input, actionKey: key });
      return executeTool(act.type, act.input, toolCtx).then((outcome) => {
        if (isWriteTool(act.type)) {
          emit({ type: "tool_disk_settled", iteration: i, actionKey: key, ok: outcome.ok });
        }
        return outcome;
      });
    });

    checkAbort();
    const outcomes = await Promise.all(outcomePromises);

    // Aggregate diffs/write tracking — mid-stream actions already counted toward didWrite.
    for (let j = 0; j < outcomes.length; j++) {
      const act = stepActions[j];
      if (earlyScheduled.has(actionScheduleKey(act.type, act.input))) continue;
      const outcome = outcomes[j];
      if (outcome.diffs?.length) {
        didWrite = true;
        writeCount += outcome.diffs.length;
        diffs.push(...outcome.diffs);
      }
    }

    const allOk = outcomes.every((o) => o.ok);
    const combinedSummary =
      outcomes.length === 1
        ? outcomes[0].summary
        : outcomes.map((o, j) => `[${stepActions[j].type}]: ${o.summary}`).join("\n\n");
    // Per-tool observation events may have already streamed each diff for the
    // early-scheduled write tools — drop those diffs here so the diff sidebar
    // doesn't merge the same hunks twice.
    const combinedDiffs = outcomes.flatMap((o, j) => {
      const act = stepActions[j];
      const early = earlyScheduled.get(actionScheduleKey(act.type, act.input));
      if (early?.streamedObservation) return [];
      return o.diffs ?? [];
    });

    if (!iterationObservationEmitted) {
      emit({ type: "observation", iteration: i, ok: allOk, summary: combinedSummary, diffs: combinedDiffs });
    }

    history.push({ role: "assistant", content: raw });
    const thoughtNudge = missingThought
      ? "\n\n⚠️ FORMAT: Your previous response was missing the required THOUGHT: block. " +
        "Every response MUST start with THOUGHT: (1–6 sentences of reasoning) before ACTION: or FINAL:."
      : "";
    history.push({ role: "user", content: `OBSERVATION (iter ${i}, ok=${allOk}):\n${combinedSummary}${thoughtNudge}` });

    // No-progress nudge: if we've done 6+ iterations without writing anything, remind the agent
    if (!didWrite && i >= 6 && i % 3 === 0) {
      const noProgressNote = 
        `\n\n[system] ⚠️ NO CHANGES YET: You've run ${i} iterations without making any file changes. ` +
        `If your task requires file edits, use write_patch now. ` +
        `If you have enough information, emit FINAL with your answer. ` +
        `Don't keep reading files without taking action.`;
      history[history.length - 1].content += noProgressNote;
      emit({ type: "log", level: "warn", message: `No changes after ${i} iterations - nudging agent to take action` });
    }

    // Wrap-up nudge: when approaching the iteration limit, remind the agent to finish
    const iterationsRemaining = maxIter - i;
    if (iterationsRemaining === 2) {
      const urgentNote =
        `\n\n[system] ⚠️ WRAP-UP WARNING: Only ${iterationsRemaining} iterations remaining before the hard limit (${maxIter}). ` +
        `If your task is nearly complete, emit FINAL on your next turn with a summary. ` +
        `If more work is needed, prioritize the most important remaining step.`;
      history[history.length - 1].content += urgentNote;
      emit({ type: "log", level: "warn", message: `Approaching iteration limit: ${iterationsRemaining} iterations remaining` });
    } else if (iterationsRemaining === 1) {
      const finalNote =
        `\n\n[system] ⚠️ FINAL ITERATION: This is your LAST turn. You MUST emit FINAL now with a summary of what you accomplished. ` +
        `If the task is incomplete, explain what remains so the user can continue.`;
      history[history.length - 1].content += finalNote;
      emit({ type: "log", level: "warn", message: `Final iteration - agent must wrap up` });
    }
  }

  // Build a helpful summary of what was accomplished
  const summaryParts: string[] = [];
  if (writeCount > 0) {
    summaryParts.push(`${writeCount} file(s) written`);
  }
  if (diffs.length > 0) {
    summaryParts.push(`${diffs.length} change(s) made`);
  }
  const accomplishedText = summaryParts.length > 0
    ? ` Progress: ${summaryParts.join(", ")}.`
    : " No files were modified.";

  finalResult = `Iteration limit (${maxIter}) reached.${accomplishedText} The task may be incomplete — you can:\n` +
    `• Continue with "keep going" or "continue"\n` +
    `• Increase Max Iterations in Settings (⚙️) for longer tasks\n` +
    `• Break the task into smaller steps`;
  emit({ type: "log", level: "warn", message: `Iteration limit reached after ${maxIter} steps` });
  emit({ type: "final", result: finalResult });
  // If the run is exiting (success or otherwise), drop any approvals that
  // somehow got orphaned. Normally the executor consumes them inline.
  cancelAllForRun(runId, "run finished");
  return { result: finalResult, iterations: maxIter, diffs, events, checkpoint: preRunCheckpoint ?? undefined };
}
