/**
 * Compact/token-optimized prompts for the agent (XML tools only).
 */

import type { ScoredFile } from "../relevance/search.js";
import { normalizePromptMode, type ContextTier } from "./prompt-mode.js";
import { priorChatSlice, taskHasPriorChat } from "./prompt.js";
export { taskHasPriorChat };
import { buildRuntimeEnvBlock } from "../utils/runtimeEnv.js";
import {
  AGENT_TOOL_FORMAT,
  AGENT_TOOL_CATALOG,
  AGENT_TOOL_EXAMPLES,
  AGENT_FORMAT_RULES,
} from "./prompt-tools.js";

function tierMultiplier(tier: ContextTier): number {
  switch (tier) {
    case 1: return 0.45;
    case 2: return 0.62;
    case 3: return 1;
    case 4: return 1.14;
    default: return 1;
  }
}

function isTightContextBudget(): boolean {
  if (process.env.LLM_CONTEXT_BUDGET === "tight") return true;
  const m = normalizePromptMode(process.env.PROMPT_MODE);
  return m === "minimal" || m === "economical";
}

function clampBudgetEnabled(): boolean {
  if (isTightContextBudget()) return true;
  const u = Number(process.env.LLM_MAX_USER_MESSAGE_CHARS);
  if (Number.isFinite(u) && u >= 1000) return true;
  const t = Number(process.env.LLM_MAX_PROMPT_CHARS);
  if (Number.isFinite(t) && t >= 4000) return true;
  return false;
}

export function activeUserTaskSlice(task: string): string {
  const m = /CURRENT TASK\s*\([^)]*\)\s*:\s*/i.exec(task);
  if (m && m.index !== undefined) return task.slice(m.index + m[0].length).trim();
  return task.trim();
}

export function safeSlice(str: string, len: number): string {
  if (str.length <= len) return str;
  let s = str.slice(0, Math.floor(len));
  if (s.length > 0) {
    const lastCode = s.charCodeAt(s.length - 1);
    if (lastCode >= 0xD800 && lastCode <= 0xDBFF) s = s.slice(0, -1);
  }
  return s;
}

export function taskSignalsConsultationFirst(task: string): boolean {
  const t = activeUserTaskSlice(task);
  if (t.length < 4) return false;
  if (/\b(plan\s+first|before\s+you\s+(start|do)|discuss\s+first|get\s+approval|what\s+do\s+you\s+think|which\s+approach|any\s+(suggestions?|ideas?)|do\s+you\s+(have|recommend|suggest))\b/i.test(t)) return true;
  if (/(lên\s*kế\s*hoạch|hỏi\s*ý\s*kiến|tham\s*khảo|chưa\s*làm|gợi\s*ý|đề\s*(xuất|cập)|ý\s*tưởng|nên\s*(làm|dùng|chọn))/i.test(t)) return true;
  if (/có\s+thể[\s\S]{0,300}(không|k|ko)\s*[?.!]?\s*$/im.test(t)) return true;
  if (/\bcó\s+(gì|ý|cách|đề\s*(xuất|cập)|gợi\s*ý|ý\s*tưởng)\b[\s\S]{0,300}(không|k|ko)?\s*[?.!]?\s*$/im.test(t)) return true;
  if (/\b(can|could)\s+you\b[\s\S]{0,300}\?\s*$/im.test(t)) return true;
  if (/(^|[\s,;:])(k|ko|kh|hông|hok|hk|khg|khong|không)\s*[?.!]?\s*$/i.test(t)) return true;
  return false;
}

export function taskIsExplanatoryQuestion(task: string): boolean {
  const t = activeUserTaskSlice(task);
  if (t.length < 5) return false;
  const viHowTo = /^(làm\s*sao|cách\s*(nào|để))/i.test(t);
  const enHowTo = /^(how\s+(do|can|to)\s+|what('s|\s+is)\s+the\s+(way|method)\s+to)/i.test(t);
  const viExplain = /^(tại\s*sao|vì\s*sao|tìm\s*hiểu|cho\s*biết|nói\s*(về|cho|thêm)|phân\s*tích|đánh\s*giá|tóm\s*tắt|review|mô\s*tả)/i.test(t);
  const enExplain = /^(what\s+(is|are|does)|why\s+(is|does)|explain|describe)/i.test(t);
  const shortQuestion = t.length < 80 && /\?\s*$/.test(t);
  const viInformalShort =
    t.length < 120 &&
    /(^|[\s,;:])(k|ko|kh|hông|hok|hk|khg|khong|không)\s*[?.!]?\s*$/i.test(t);
  const viCodeQuestions =
    /(file|thư\s*mục|cái\s*này|hàm|code|đoạn\s*này).*?(là\s*(gì|file\s*gì)|để\s*làm\s*gì|có\s*tác\s*dụng\s*gì|xóa\s*được\s*không|có\s*nên\s*xóa|dùng\s*để)/i.test(t);
  return viHowTo || viExplain || enHowTo || enExplain || shortQuestion || viInformalShort || viCodeQuestions;
}

export const SYSTEM_PROMPT_COMPACT = `You are Pig Agents Desktop — local coding agent with real filesystem tools.

${AGENT_TOOL_FORMAT}

${AGENT_TOOL_CATALOG}

${AGENT_TOOL_EXAMPLES}

${AGENT_FORMAT_RULES}

EFFICIENCY:
- write_patch/create_file save under WORKSPACE_PATH — never refuse as unavailable.
- read_file/search_code before shell for code reading.
- One tool per turn for fixes; parallel read_file only when needed.
- write_patch with CDATA for HTML/large files; create_file content verbatim (no END sentinel).
- Browser → browser_show + browser_navigate (index.html or http://localhost:PORT); never run_command start/explorer on Windows.
- Match RUNTIME ENV shell syntax for run_command.

RULES:
1. THOUGHT + <tool> or THOUGHT + FINAL each turn
2. Bug/fix → search_code, read_file, minimal write_patch
3. Simple questions → FINAL directly
4. Match user language in FINAL`;

export const SYSTEM_PROMPT_MINIMAL = `Pig Agents Desktop agent. Format:

THOUGHT: <reasoning>
<tool name="tool_name"><param>value</param></tool>
OR
THOUGHT: <done>
FINAL: <answer>

Use CDATA for patches/content/cmd. Check RUNTIME ENV for shell. write_patch/create_file save to disk.

Example:
<tool name="read_file"><path>main.ts</path></tool>
<tool name="browser_show" />`;

export const ASK_SYSTEM_PROMPT_COMPACT = `Helpful coding assistant. Answer in Markdown.
- Use fenced code blocks with language tags
- Be concise, skip filler
- Never output THOUGHT/FINAL/<tool> markup
- Reply in plain Markdown only`;

export const ASK_SYSTEM_PROMPT_MINIMAL = `Coding assistant. Reply in Markdown only (no tools). Short answers; code in fenced blocks.`;

export function buildContextMessageCompact(
  task: string,
  relevant: ScoredFile[],
  history: { role: "assistant" | "user" | "system"; content: string }[],
  tier: ContextTier = 3,
  tree?: string,
  workspacePath?: string,
  opts?: { iteration?: number; extraHint?: string },
): string {
  const tight = isTightContextBudget();
  const tm = tierMultiplier(tier);
  const basePreview = tight
    ? history.length > 4 ? 280 : history.length > 2 ? 420 : 560
    : history.length > 14 ? 520 : history.length > 10 ? 620 : history.length > 6 ? 700 : history.length > 2 ? 780 : 880;
  const previewLen = Math.max(120, Math.round(basePreview * tm));

  const iter = opts?.iteration ?? 1;
  const historyHasObs = history.some((m) => m.role === "user" && m.content.includes("OBSERVATION"));
  const skipFilePreviews = iter > 1 && historyHasObs;

  const filesBlock =
    relevant.length === 0
      ? "(none)"
      : skipFilePreviews
        ? relevant.map((f) => `[${f.path}] (preview omitted — see HISTORY or read_file)`).join("\n")
        : relevant
            .map((f) => `[${f.path}]\n${safeSlice(f.preview, previewLen)}${f.preview.length > previewLen ? "…" : ""}`)
            .join("\n\n");

  let historyCap = 8;
  if (tier <= 1) historyCap = 5;
  else if (tier === 2) historyCap = 6;

  const historyLimit = tight
    ? history.length > 8 ? 2 : history.length > 4 ? 3 : 5
    : Math.min(historyCap, history.length);
  const msgCap = Math.round((tight ? (history.length > 6 ? 900 : 1200) : 2400) * tm);
  const obsCap = Math.round((tight ? 700 : 1500) * tm);
  const recentHistory = history
    .slice(-historyLimit)
    .map((m) => {
      const content =
        m.role === "user" && m.content.includes("OBSERVATION")
          ? truncateObservation(m.content, obsCap)
          : safeSlice(m.content, msgCap);
      return `[${m.role.toUpperCase()}] ${content}`;
    })
    .join("\n\n");

  let hint = "";
  if (taskSignalsConsultationFirst(task)) {
    hint = "\n[hint: plan/feasibility/suggestion question — FINAL only, NO tools]";
  } else if (taskIsExplanatoryQuestion(task)) {
    hint = "\n[hint: how-to/explain question — answer in FINAL, at most ONE read_file]";
  }

  const workspaceSection = tree ? `\nWORKSPACE:\n${tree}\n` : "";
  const workspacePathLine = workspacePath
    ? `\nWORKSPACE_PATH: ${workspacePath} (run_command cwd; do NOT cd to other absolute paths)\n`
    : "";

  const activeTask = activeUserTaskSlice(task);
  const priorChat = priorChatSlice(task);

  const extraHint = opts?.extraHint ?? "";

  return `CURRENT TASK: ${activeTask}${hint}${extraHint}${buildRuntimeEnvBlock()}${workspacePathLine}${workspaceSection}${priorChat ? `\nPRIOR CHAT:\n${priorChat}\n` : ""}

FILES:
${filesBlock}

HISTORY:
${recentHistory || "(start)"}`;
}

function truncateObservation(content: string, maxLen: number): string {
  if (content.length <= maxLen) return content;
  const lines = content.split("\n");
  const header = lines.slice(0, 3).join("\n");
  const footer = lines.slice(-5).join("\n");
  const mid = content.slice(header.length, -footer.length);
  if (mid.length > maxLen - header.length - footer.length - 20) {
    return `${header}\n…[${Math.floor(mid.length / 1000)}k chars truncated]…\n${footer}`;
  }
  return safeSlice(content, maxLen) + "…";
}

export function buildAskMessageCompact(
  task: string,
  relevant: ScoredFile[],
  history: { role: string; content: string }[],
  tier: ContextTier = 3,
): string {
  const tight = isTightContextBudget();
  const tm = tierMultiplier(tier);
  const fileCap = Math.round((tight ? (history.length > 4 ? 380 : 480) : 800) * tm);
  const histCap = Math.round((tight ? (history.length > 5 ? 600 : 850) : 1400) * tm);
  let histMax = 8;
  if (tier <= 1) histMax = 4;
  else if (tier === 2) histMax = 5;
  const histN = tight ? (history.length > 8 ? 3 : 4) : Math.min(histMax, history.length);
  const filesBlock =
    relevant.length === 0
      ? "(none)"
      : relevant.map((f) => `[${f.path}]\n${safeSlice(f.preview, fileCap)}`).join("\n\n");
  const recent = history
    .slice(-histN)
    .map((m) => `[${m.role}] ${safeSlice(m.content, histCap)}`)
    .join("\n\n");
  return `Q: ${task}

FILES:
${filesBlock}

HISTORY:
${recent || "(none)"}`;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function readMaxUserMessageChars(): number {
  const u = Number(process.env.LLM_MAX_USER_MESSAGE_CHARS);
  if (Number.isFinite(u) && u >= 1000) return Math.floor(u);
  if (isTightContextBudget()) {
    const m = normalizePromptMode(process.env.PROMPT_MODE);
    if (m === "minimal") return 4500;
    if (m === "economical") return 6500;
    return 9000;
  }
  return Number.MAX_SAFE_INTEGER;
}

function readMaxTotalPromptChars(): number {
  const t = Number(process.env.LLM_MAX_PROMPT_CHARS);
  if (Number.isFinite(t) && t >= 4000) return Math.floor(t);
  if (isTightContextBudget()) {
    const m = normalizePromptMode(process.env.PROMPT_MODE);
    if (m === "minimal") return 8000;
    if (m === "economical") return 11000;
    return 14000;
  }
  return Number.MAX_SAFE_INTEGER;
}

function trimCompactContextMessage(msg: string, maxChars: number): string {
  if (msg.length <= maxChars) return msg;
  const note = "\n\n[…context truncated: shorten the chat or start a new session]";
  const budget = Math.max(400, maxChars - note.length - 20);
  const histKey = "\n\nHISTORY:\n";
  const filesKey = "\n\nFILES:\n";
  const hi = msg.indexOf(histKey);
  const fi = msg.indexOf(filesKey);
  if (fi === -1 || hi === -1 || hi < fi) return msg.slice(0, budget) + note;
  const head = msg.slice(0, fi);
  let filesBlock = msg.slice(fi + filesKey.length, hi);
  let historyBlock = msg.slice(hi + histKey.length);
  function total(): number {
    return head.length + filesKey.length + filesBlock.length + histKey.length + historyBlock.length;
  }
  while (total() > budget && historyBlock.length > 80) {
    historyBlock = historyBlock.slice(Math.floor(historyBlock.length / 2));
  }
  while (total() > budget && filesBlock.length > 80) {
    const mid = Math.floor(filesBlock.length / 2);
    const cut = filesBlock.lastIndexOf("\n\n", mid);
    filesBlock = cut > 40 ? safeSlice(filesBlock, cut) : safeSlice(filesBlock, mid);
  }
  let out = head + filesKey + filesBlock + histKey + historyBlock;
  if (out.length > budget) out = safeSlice(out, budget);
  return out + note;
}

export function clampUserMessageToInputBudget(systemPrompt: string, userMsg: string): string {
  if (!clampBudgetEnabled()) return userMsg;
  const maxUser = readMaxUserMessageChars();
  const maxTotal = readMaxTotalPromptChars();
  let u = userMsg;
  if (u.length > maxUser) u = trimCompactContextMessage(u, maxUser);
  while (systemPrompt.length + u.length > maxTotal && u.length > 1200) {
    const room = Math.max(1200, maxTotal - systemPrompt.length - 120);
    u = trimCompactContextMessage(u, room);
  }
  // The loop floors at 1200 chars, so a very large system prompt can still
  // leave the combined prompt over budget. Trim once more to the real room —
  // but only when there's still a usable amount left, so we never nuke the
  // task entirely (an oversized system prompt alone is simply unfixable here).
  if (systemPrompt.length + u.length > maxTotal) {
    const room = maxTotal - systemPrompt.length;
    if (room >= 400 && u.length > room) u = trimCompactContextMessage(u, room);
  }
  return u;
}

export function selectPromptVersion(task: string, _historyLength: number): "compact" | "minimal" {
  if (process.env.LLM_DISABLE_MINIMAL_PROMPT === "1" || process.env.LLM_DISABLE_MINIMAL_PROMPT === "true") {
    return "compact";
  }
  const t = activeUserTaskSlice(task).trim();
  if (/\b(fix|bug|lỗi|sửa|optimize|tối ưu|refactor|patch|error)\b/i.test(t)) return "compact";
  if (/^(ok|tiếp|continue|go|do it|làm|làm đi|yes|yep)\s*$/i.test(t)) return "minimal";
  return "compact";
}
