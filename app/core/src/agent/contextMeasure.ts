import { estimateTokens } from "../llm/prompt-compact.js";
import {
  SYSTEM_PROMPT,
  ASK_SYSTEM_PROMPT,
  buildContextMessage,
  buildAskMessage,
  activeUserTaskSlice,
} from "../llm/prompt.js";
import {
  SYSTEM_PROMPT_COMPACT,
  SYSTEM_PROMPT_MINIMAL,
  ASK_SYSTEM_PROMPT_COMPACT,
  ASK_SYSTEM_PROMPT_MINIMAL,
  buildContextMessageCompact,
  buildAskMessageCompact,
  selectPromptVersion,
  clampUserMessageToInputBudget,
} from "../llm/prompt-compact.js";
import {
  normalizePromptMode,
  promptModeToContextTier,
  maxOutputTokensForMode,
} from "../llm/prompt-mode.js";
import { taskShapeContextHint } from "./taskShape.js";
import { rankRelevant } from "../relevance/search.js";
import { buildCompactTree } from "../tools/file.js";
import { getWorkspace } from "../utils/workspace.js";
import { loadProjectRules } from "../utils/projectRules.js";
import type { AgentMode } from "./runner.js";
import type { LLMUsage } from "../llm/client.js";

export interface ContextSegment {
  id: string;
  label: string;
  tokens: number;
  chars: number;
  color: string;
}

export interface ContextUsageSnapshot {
  iteration?: number;
  segments: ContextSegment[];
  /** Input tokens — API value when available, else measured from prompt text. */
  inputTokens: number;
  /** Measured input tokens from composed prompt (always present). */
  inputTokensMeasured: number;
  promptTokensApi?: number;
  completionTokensApi?: number;
  limitTokens: number;
  percent: number;
  source: "measured" | "api" | "preview";
  trimmed: boolean;
  relevantFileCount: number;
}

const SEGMENT_COLORS: Record<string, string> = {
  system: "#9ca3af",
  tools: "#a78bfa",
  rules: "#34d399",
  workspace: "#818cf8",
  files: "#60a5fa",
  conversation: "#e8a87c",
  current: "#f472b6",
};

/** Context window size for the configured model (from env MODEL). */
export function contextLimitForModel(model: string | undefined): number {
  const m = (model ?? process.env.MODEL ?? "").toLowerCase();
  if (m.includes("1m") || m.includes("gemini-1.5") || m.includes("gemini-2")) return 1_000_000;
  if (m.includes("200k") || m.includes("claude-opus") || m.includes("claude-sonnet-4")) return 200_000;
  if (m.includes("128k") || m.includes("gpt-4") || m.includes("deepseek")) return 128_000;
  if (m.includes("32k")) return 32_000;
  if (m.includes("8k") || m.includes("3.5")) return 8_192;
  return 128_000;
}

function seg(id: string, label: string, text: string): ContextSegment {
  return {
    id,
    label,
    tokens: estimateTokens(text),
    chars: text.length,
    color: SEGMENT_COLORS[id] ?? "#9ca3af",
  };
}

function splitProjectRules(systemPrompt: string, projectRulesBlock: string): {
  systemBase: string;
  projectRules: string;
} {
  if (!projectRulesBlock || !systemPrompt.endsWith(projectRulesBlock)) {
    return { systemBase: systemPrompt, projectRules: "" };
  }
  return {
    systemBase: systemPrompt.slice(0, systemPrompt.length - projectRulesBlock.length),
    projectRules: projectRulesBlock,
  };
}

/** Split agent system prompt into instructions vs tool catalog. */
function splitSystemTools(systemBase: string, mode: AgentMode): { core: string; tools: string } {
  if (mode === "ask") return { core: systemBase, tools: "" };
  const m = systemBase.match(/\nTools?:\s*/i);
  if (!m || m.index === undefined) return { core: systemBase, tools: "" };
  const toolsStart = m.index;
  const afterTools = systemBase.slice(toolsStart + m[0].length);
  const nextSection = afterTools.search(/\n(?:EXAMPLES?|RULES|Parallel):/i);
  const toolsEnd =
    nextSection === -1 ? systemBase.length : toolsStart + m[0].length + nextSection;
  return {
    core: systemBase.slice(0, toolsStart) + systemBase.slice(toolsEnd),
    tools: systemBase.slice(toolsStart, toolsEnd),
  };
}

function parseAgentUserMessage(userMsg: string): {
  currentTask: string;
  priorChat: string;
  workspace: string;
  files: string;
  history: string;
} {
  const filesKey = "\n\nFILES:\n";
  const histKey = "\n\nHISTORY:\n";
  const fi = userMsg.indexOf(filesKey);
  const hi = userMsg.indexOf(histKey);

  if (fi === -1 || hi === -1 || hi < fi) {
    return { currentTask: userMsg, priorChat: "", workspace: "", files: "", history: "" };
  }

  const head = userMsg.slice(0, fi);
  const files = userMsg.slice(fi + filesKey.length, hi);
  const history = userMsg.slice(hi + histKey.length);

  const priorKey = "\nPRIOR CHAT:\n";
  const pi = head.indexOf(priorKey);
  let currentTask = head;
  let priorChat = "";
  if (pi !== -1) {
    currentTask = head.slice(0, pi);
    priorChat = head.slice(pi + priorKey.length);
  }

  const wsPathKey = "\nWORKSPACE_PATH:";
  const wsTreeKey = "\nWORKSPACE:\n";
  let workspace = "";
  const wpi = currentTask.indexOf(wsPathKey);
  const wti = currentTask.indexOf(wsTreeKey);
  if (wpi !== -1 || wti !== -1) {
    const cut = Math.min(
      wpi !== -1 ? wpi : currentTask.length,
      wti !== -1 ? wti : currentTask.length,
    );
    workspace = currentTask.slice(cut);
    currentTask = currentTask.slice(0, cut);
  }

  if (currentTask.startsWith("CURRENT TASK:")) {
    currentTask = currentTask.slice("CURRENT TASK:".length);
  }

  return {
    currentTask: currentTask.trim(),
    priorChat: priorChat.trim(),
    workspace: workspace.trim(),
    files: files.trim(),
    history: history.trim(),
  };
}

function parseAskUserMessage(userMsg: string): {
  currentTask: string;
  files: string;
  history: string;
} {
  const filesKey = "\n\nFILES:\n";
  const histKey = "\n\nHISTORY:\n";
  const fi = userMsg.indexOf(filesKey);
  const hi = userMsg.indexOf(histKey);
  if (fi === -1 || hi === -1) {
    return { currentTask: userMsg.replace(/^Q:\s*/, "").trim(), files: "", history: "" };
  }
  const head = userMsg.slice(0, fi);
  return {
    currentTask: head.replace(/^Q:\s*/, "").trim(),
    files: userMsg.slice(fi + filesKey.length, hi).trim(),
    history: userMsg.slice(hi + histKey.length).trim(),
  };
}

export function measureContextUsage(opts: {
  systemPrompt: string;
  projectRulesBlock: string;
  userMsg: string;
  mode: AgentMode;
  iteration?: number;
  apiUsage?: LLMUsage;
  trimmed?: boolean;
  relevantFileCount?: number;
  source?: ContextUsageSnapshot["source"];
}): ContextUsageSnapshot {
  const { systemBase, projectRules } = splitProjectRules(opts.systemPrompt, opts.projectRulesBlock);
  const { core, tools } = splitSystemTools(systemBase, opts.mode);

  const segments: ContextSegment[] = [
    seg("system", "System prompt", core),
    ...(tools ? [seg("tools", "Tool definitions", tools)] : []),
    ...(projectRules ? [seg("rules", "Project rules", projectRules)] : []),
  ];

  if (opts.mode === "agent") {
    const parts = parseAgentUserMessage(opts.userMsg);
    if (parts.workspace) segments.push(seg("workspace", "Workspace tree", parts.workspace));
    const conversationParts = [parts.priorChat, parts.history].filter(
      (t) => t && t !== "(start)" && t !== "(none)",
    );
    if (conversationParts.length > 0) {
      segments.push(seg("conversation", "Conversation", conversationParts.join("\n\n")));
    }
    segments.push(seg("current", "Current task", parts.currentTask));
    if (parts.files && parts.files !== "(none)") segments.push(seg("files", "File context", parts.files));
  } else {
    const parts = parseAskUserMessage(opts.userMsg);
    segments.push(seg("current", "Question", parts.currentTask));
    if (parts.files && parts.files !== "(none)") segments.push(seg("files", "File context", parts.files));
    if (parts.history && parts.history !== "(none)") {
      segments.push(seg("conversation", "History", parts.history));
    }
  }

  const finalSegments = segments.filter((s) => s.chars > 0);

  const inputTokensMeasured = estimateTokens(opts.systemPrompt) + estimateTokens(opts.userMsg);
  const promptTokensApi = opts.apiUsage?.promptTokens;
  const inputTokens = promptTokensApi ?? inputTokensMeasured;
  const limitTokens = contextLimitForModel(process.env.MODEL);
  const percent = Math.min(100, Math.round((inputTokens / limitTokens) * 100));

  let displaySegments = finalSegments;
  if (promptTokensApi != null && inputTokensMeasured > 0 && promptTokensApi !== inputTokensMeasured) {
    const scale = promptTokensApi / inputTokensMeasured;
    displaySegments = finalSegments.map((s) => ({
      ...s,
      tokens: Math.max(1, Math.round(s.tokens * scale)),
    }));
  }

  return {
    iteration: opts.iteration,
    segments: displaySegments,
    inputTokens,
    inputTokensMeasured,
    promptTokensApi,
    completionTokensApi: opts.apiUsage?.completionTokens,
    limitTokens,
    percent,
    source: opts.apiUsage?.promptTokens != null ? "api" : (opts.source ?? "measured"),
    trimmed: opts.trimmed ?? false,
    relevantFileCount: opts.relevantFileCount ?? 0,
  };
}

export async function buildPromptForContextPreview(opts: {
  task: string;
  mode: AgentMode;
  reactHistory?: { role: "user" | "assistant" | "system"; content: string }[];
}): Promise<{
  systemPrompt: string;
  userMsg: string;
  projectRulesBlock: string;
  trimmed: boolean;
  relevantFileCount: number;
}> {
  const wsRoot = getWorkspace();
  const loadedRules = loadProjectRules(wsRoot);
  const projectRulesBlock =
    loadedRules.text.length > 0
      ? `\n\n---\nPROJECT RULES (this workspace — follow over generic defaults):\n${loadedRules.text}`
      : "";

  const mode = opts.mode;
  const maxFiles = Math.max(1, Number(process.env.MAX_CONTEXT_FILES || 3));
  const taskForRanking = activeUserTaskSlice(opts.task);
  const [relevant, compactTree] = await Promise.all([
    rankRelevant(taskForRanking, maxFiles),
    buildCompactTree(3, 180).catch(() => ""),
  ]);

  const history = opts.reactHistory ?? [];
  const promptMode = normalizePromptMode(process.env.PROMPT_MODE);

  let systemPrompt: string;
  let userMsg: string;

  if (mode === "ask") {
    const askTier = promptModeToContextTier(promptMode);
    if (promptMode === "verbose") {
      systemPrompt = ASK_SYSTEM_PROMPT + projectRulesBlock;
      userMsg = buildAskMessage(opts.task, relevant, history);
    } else {
      systemPrompt =
        (promptMode === "minimal" ? ASK_SYSTEM_PROMPT_MINIMAL : ASK_SYSTEM_PROMPT_COMPACT) +
        projectRulesBlock;
      userMsg = buildAskMessageCompact(opts.task, relevant, history, askTier);
    }
  } else if (promptMode === "verbose") {
    systemPrompt = SYSTEM_PROMPT + projectRulesBlock;
    userMsg = buildContextMessage(opts.task, relevant, history, compactTree, wsRoot);
  } else {
    const contextTier = promptModeToContextTier(promptMode);
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
    userMsg = buildContextMessageCompact(opts.task, relevant, history, contextTier, compactTree, wsRoot, {
      iteration: 1,
      extraHint: taskShapeContextHint(opts.task),
    });
  }

  const umBefore = userMsg.length;
  userMsg = clampUserMessageToInputBudget(systemPrompt, userMsg);
  const trimmed = userMsg.length < umBefore - 40;

  return {
    systemPrompt,
    userMsg,
    projectRulesBlock,
    trimmed,
    relevantFileCount: relevant.length,
  };
}

export async function previewContextUsage(opts: {
  task: string;
  mode: AgentMode;
}): Promise<ContextUsageSnapshot> {
  const built = await buildPromptForContextPreview(opts);
  return measureContextUsage({
    systemPrompt: built.systemPrompt,
    projectRulesBlock: built.projectRulesBlock,
    userMsg: built.userMsg,
    mode: opts.mode,
    trimmed: built.trimmed,
    relevantFileCount: built.relevantFileCount,
    source: "preview",
  });
}

export { maxOutputTokensForMode };
