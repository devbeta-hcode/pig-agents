/**
 * Compact/token-optimized prompts for the agent.
 * These are significantly shorter than the verbose versions in prompt.ts
 * but preserve all critical behavior rules.
 */

import type { ScoredFile } from "../relevance/search.js";
import { normalizePromptMode, type ContextTier } from "./prompt-mode.js";

function tierMultiplier(tier: ContextTier): number {
  switch (tier) {
    case 1:
      return 0.45;
    case 2:
      return 0.62;
    case 3:
      return 1;
    case 4:
      return 1.14;
    default:
      return 1;
  }
}

/** When `tight`, use smaller previews/history (cheap TPM tiers). Default `full` keeps agent context strong. */
function isTightContextBudget(): boolean {
  if (process.env.LLM_CONTEXT_BUDGET === "tight") return true;
  const m = normalizePromptMode(process.env.PROMPT_MODE);
  return m === "minimal" || m === "economical";
}

/** Hard trim only when user opts in (tight mode or valid numeric LLM_MAX_* caps). */
function clampBudgetEnabled(): boolean {
  if (isTightContextBudget()) return true;
  const u = Number(process.env.LLM_MAX_USER_MESSAGE_CHARS);
  if (Number.isFinite(u) && u >= 1000) return true;
  const t = Number(process.env.LLM_MAX_PROMPT_CHARS);
  if (Number.isFinite(t) && t >= 4000) return true;
  return false;
}

/** Extract the active user task from a potentially multi-turn message */
export function activeUserTaskSlice(task: string): string {
  const m = /CURRENT TASK\s*\([^)]*\)\s*:\s*/i.exec(task);
  if (m && m.index !== undefined) return task.slice(m.index + m[0].length).trim();
  return task.trim();
}

/** Detect consultation/feasibility questions */
export function taskSignalsConsultationFirst(task: string): boolean {
  const t = activeUserTaskSlice(task);
  if (t.length < 4) return false;
  // Plan/consult patterns (EN + VI)
  if (/\b(plan\s+first|before\s+you\s+(start|do)|discuss\s+first|get\s+approval|what\s+do\s+you\s+think|which\s+approach|any\s+(suggestions?|ideas?)|do\s+you\s+(have|recommend|suggest))\b/i.test(t)) return true;
  if (/(lên\s*kế\s*hoạch|hỏi\s*ý\s*kiến|tham\s*khảo|chưa\s*làm|gợi\s*ý|đề\s*(xuất|cập)|ý\s*tưởng|nên\s*(làm|dùng|chọn))/i.test(t)) return true;
  // Feasibility questions
  if (/có\s+thể[\s\S]{0,300}(không|k|ko)\s*[?.!]?\s*$/im.test(t)) return true;
  if (/\bcó\s+(gì|ý|cách|đề\s*(xuất|cập)|gợi\s*ý|ý\s*tưởng)\b[\s\S]{0,300}(không|k|ko)?\s*[?.!]?\s*$/im.test(t)) return true;
  if (/\b(can|could)\s+you\b[\s\S]{0,300}\?\s*$/im.test(t)) return true;
  // VI informal yes/no ending in bare "k/ko/kh/hông"
  if (/(^|[\s,;:])(k|ko|kh|hông|hok|hk|khg|khong|không)\s*[?.!]?\s*$/i.test(t)) return true;
  return false;
}

/** Detect how-to / explanatory questions */
export function taskIsExplanatoryQuestion(task: string): boolean {
  const t = activeUserTaskSlice(task);
  if (t.length < 5) return false;
  // How-to patterns
  const viHowTo = /^(làm\s*sao|cách\s*(nào|để))/i.test(t);
  const enHowTo = /^(how\s+(do|can|to)\s+|what('s|\s+is)\s+the\s+(way|method)\s+to)/i.test(t);
  // Explanation patterns
  const viExplain = /^(tại\s*sao|vì\s*sao|tìm\s*hiểu|cho\s*biết|nói\s*(về|cho|thêm)|phân\s*tích|đánh\s*giá|tóm\s*tắt|review|mô\s*tả)/i.test(t);
  const enExplain = /^(what\s+(is|are|does)|why\s+(is|does)|explain|describe)/i.test(t);
  // Short questions
  const shortQuestion = t.length < 80 && /\?\s*$/.test(t);
  // VI informal yes/no on short messages
  const viInformalShort =
    t.length < 120 &&
    /(^|[\s,;:])(k|ko|kh|hông|hok|hk|khg|khong|không)\s*[?.!]?\s*$/i.test(t);

  const viCodeQuestions =
    /(file|thư\s*mục|cái\s*này|hàm|code|đoạn\s*này).*?(là\s*(gì|file\s*gì)|để\s*làm\s*gì|có\s*tác\s*dụng\s*gì|xóa\s*được\s*không|có\s*nên\s*xóa|dùng\s*để)/i.test(t);

  return viHowTo || viExplain || enHowTo || enExplain || shortQuestion || viInformalShort || viCodeQuestions;
}

/**
 * Compact system prompt - ~60% fewer tokens than verbose version.
 * All critical rules preserved, redundancy removed.
 * Includes few-shot examples for smaller models.
 */
export const SYSTEM_PROMPT_COMPACT = `You are an autonomous coding agent. Respond in ReAct format.

FORMAT (THOUGHT is MANDATORY — every response must start with THOUGHT:):
THOUGHT: <what you know, what to do next — required before any ACTION or FINAL>
ACTION: {"type":"<tool>","input":{...}}

OR when done:
THOUGHT: <brief summary of what was done>
FINAL: <answer to user>

WARNING: Responses without THOUGHT: will be rejected. Always begin with THOUGHT:.

TOOLS:
- codebase_map: {"type":"codebase_map","input":{"max_depth":3}} — full tree + manifest excerpts. SKIP if WORKSPACE already in context (it is by default); only call for deeper exploration.
- read_file: {"type":"read_file","input":{"path":"src/file.ts"}}
- list_files: {"type":"list_files","input":{"dir":"src"}}
- search_code: {"type":"search_code","input":{"query":"function name"}}
- glob: {"type":"glob","input":{"pattern":"**/*.ts"}}
- run_command: {"type":"run_command","input":{"cmd":"npm test","background":true}} — runs with cwd = workspace root (see WORKSPACE_PATH below). Set "background": true to force detach long-running servers. Do NOT prefix with "cd /workspace", "cd /data/workspace", or any imagined absolute path — they don't exist; the command will fail with "No such file or directory". For sub-folders use relative "cd ./sub && ...".
- write_patch: {"type":"write_patch","input":{"patches":"FILE:path\\nSEARCH\\n<old>\\nREPLACE\\n<new>\\nEND"}} — after FILE: rel/path the next line must be SEARCH then REPLACE (never raw file body under FILE:); new file = SEARCH\\n\\nREPLACE\\n<content>\\nEND. Or {"path":"x.ts","patches":"SEARCH\\n..."} only.
- create_file: {"type":"create_file","input":{"path":"src/new.ts","content":"// file content"}} — content is written verbatim. Do NOT add END/EOF/END_OF_FILE markers; those belong to write_patch and will end up as literal text breaking the file.
- web_search: {"type":"web_search","input":{"query":"react useEffect cleanup"}} — DDG HTML scrape, top results (title/url/snippet). Each call needs user approval unless auto-allow is on.
- web_fetch: {"type":"web_fetch","input":{"url":"https://docs.example.com/api"}} — fetch HTTP(S), strip HTML, return plaintext (capped). Refuses localhost/private IPs. Each call needs user approval unless auto-allow is on.
- browser_show: {"type":"browser_show","input":{}} — open the embedded Browser tab (no external Chrome/Edge). Use when user asks to "open browser" / "mở trình duyệt".
- browser_navigate: {"type":"browser_navigate","input":{"url":"https://app.local"}} — load URL in embedded Browser; url optional / "about:blank" = open panel only. NEVER run_command start chrome|msedge|explorer.
- browser_get_text: {"type":"browser_get_text","input":{"selector":"main"}} — visible text of current page (or selector). Run after browser_navigate.
- browser_get_html: {"type":"browser_get_html","input":{"selector":"#root"}} — outer HTML of current page (or selector).
- browser_click: {"type":"browser_click","input":{"selector":"button.submit"}} — click element. Selectors: CSS, text=Search, placeholder=Email, aria=Submit, role=button[name=Play], name=search_query. Pierces shadow DOM. Use browser_wait_for first on SPAs.
- browser_fill: {"type":"browser_fill","input":{"selector":"input[name=q]","value":"hello"}} — fill input/textarea (React-friendly). Same selector dialect as browser_click.
- browser_wait_for: {"type":"browser_wait_for","input":{"selector":".ready","state":"visible"}} — wait for selector before reading/clicking.
- browser_eval: {"type":"browser_eval","input":{"js":"document.title"}} — run JS in page, JSON-stringified result. Escape hatch.

Parallel: emit multiple ACTION lines for independent ops (e.g. reading several files at once).

EXAMPLES:

User: "What does server.ts do?"
THOUGHT: I need to read server.ts to understand its purpose.
ACTION: {"type":"read_file","input":{"path":"src/server.ts"}}

User: "Fix the typo in README.md"
THOUGHT: First read README to find the typo.
ACTION: {"type":"read_file","input":{"path":"README.md"}}

User: "Create a hello.txt file"
THOUGHT: I'll create the file with write_patch.
ACTION: {"type":"write_patch","input":{"patches":"FILE:hello.txt\\nSEARCH\\n\\nREPLACE\\nHello World!\\nEND"}}

User: "How are you?"
THOUGHT: This is a greeting, not a coding task.
FINAL: I'm doing well! How can I help you with your code today?

User: "Mở trình duyệt tool"
THOUGHT: User wants the embedded Browser panel, not an external browser app.
ACTION: {"type":"browser_show","input":{}}

RULES:
1. ONE action per turn (THOUGHT + ACTION, or THOUGHT + FINAL)
2. Questions about files → read_file first
3. Creating/editing files → use write_patch (never paste code in FINAL); each FILE: block must use SEARCH/REPLACE lines as in TOOLS. On patch failure read OBSERVATION codes like [WP_SEARCH_MISS].
4. Simple questions → FINAL directly (user-facing text only — no meta-rubric, no THOUGHT pasted into FINAL)
5. Match user's language in FINAL
6. Open/show browser → browser_show or browser_navigate (about:blank). NEVER run_command to launch Chrome/Edge/Firefox — only the embedded Browser panel exists in this app.`;

/** Even more compact for simple tasks */
export const SYSTEM_PROMPT_MINIMAL = `Coding agent. Format (THOUGHT is required every time):

THOUGHT: <reasoning — mandatory>
ACTION: {"type":"tool","input":{...}}
OR
THOUGHT: <done>
FINAL: <answer>

Tools: codebase_map (rarely needed — tree is in context), read_file, list_files, search_code, glob, run_command, write_patch, create_file, web_search, web_fetch, browser_show, browser_navigate, browser_get_text, browser_click, browser_fill, browser_eval

Example open browser:
User: "Mở trình duyệt"
THOUGHT: Open embedded Browser tab only.
ACTION: {"type":"browser_show","input":{}}

Example read file:
User: "Read main.ts"
THOUGHT: Reading the file.
ACTION: {"type":"read_file","input":{"path":"main.ts"}}`;

/** ASK mode prompt */
export const ASK_SYSTEM_PROMPT_COMPACT = `Helpful coding assistant. Answer in Markdown.
- Use fenced code blocks with language tags
- Be concise, skip filler
- If proposing changes, show the patched code
- Never output THOUGHT/ACTION/FINAL format
- Reply in plain Markdown only — no internal meta-rubric lines (e.g. language tags "describing that I…")`;

/** Ultra-short ASK system prompt (minimal token use). */
export const ASK_SYSTEM_PROMPT_MINIMAL = `Coding assistant. Reply in Markdown only (no tools). Short answers; code in fenced blocks.`;

/**
 * Build context message with smart truncation based on history length.
 * Fewer tokens when history is long, more context when history is short.
 */
export function buildContextMessageCompact(
  task: string,
  relevant: ScoredFile[],
  history: { role: "assistant" | "user" | "system"; content: string }[],
  tier: ContextTier = 3,
  tree?: string,
  workspacePath?: string,
): string {
  const tight = isTightContextBudget();
  const tm = tierMultiplier(tier);
  const basePreview = tight
    ? history.length > 4 ? 280 : history.length > 2 ? 420 : 560
    : history.length > 14 ? 520 : history.length > 10 ? 620 : history.length > 6 ? 700 : history.length > 2 ? 780 : 880;
  const previewLen = Math.max(120, Math.round(basePreview * tm));

  const filesBlock = relevant.length === 0
    ? "(none)"
    : relevant
      .map((f) => `[${f.path}]\n${f.preview.slice(0, previewLen)}${f.preview.length > previewLen ? "…" : ""}`)
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
          : m.content.slice(0, msgCap);
      return `[${m.role.toUpperCase()}] ${content}`;
    })
    .join("\n\n");

  // Inject hint on every turn (classifier reads CURRENT TASK slice = latest user message).
  let hint = "";
  if (taskSignalsConsultationFirst(task)) {
    hint = "\n[hint: plan/feasibility/suggestion question — FINAL only, NO tools]";
  } else if (taskIsExplanatoryQuestion(task)) {
    hint = "\n[hint: how-to/explain question — answer in FINAL, at most ONE read_file]";
  }

  const workspaceSection = tree ? `\nWORKSPACE:\n${tree}\n` : "";
  // Absolute cwd — see buildContextMessage in prompt.ts for rationale.
  const workspacePathLine = workspacePath
    ? `\nWORKSPACE_PATH: ${workspacePath} (run_command cwd; do NOT cd to other absolute paths)\n`
    : "";

  const activeTask = activeUserTaskSlice(task);
  const priorChat = (() => {
    if (activeTask === task.trim()) return "";
    const idx = task.lastIndexOf(activeTask);
    if (idx <= 0) return "";
    return task.slice(0, idx).trim();
  })();

  return `CURRENT TASK: ${activeTask}${hint}${workspacePathLine}${workspaceSection}${priorChat ? `\nPRIOR CHAT:\n${priorChat}\n` : ""}

FILES:
${filesBlock}

HISTORY:
${recentHistory || "(start)"}`;
}

/** Truncate observation output intelligently */
function truncateObservation(content: string, maxLen: number): string {
  if (content.length <= maxLen) return content;
  
  // Keep the header and result summary, truncate middle
  const lines = content.split('\n');
  const header = lines.slice(0, 3).join('\n');
  const footer = lines.slice(-5).join('\n');
  const mid = content.slice(header.length, -footer.length);
  
  if (mid.length > maxLen - header.length - footer.length - 20) {
    return `${header}\n…[${Math.floor(mid.length/1000)}k chars truncated]…\n${footer}`;
  }
  return content.slice(0, maxLen) + '…';
}

/**
 * Build ASK mode message
 */
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
      : relevant.map((f) => `[${f.path}]\n${f.preview.slice(0, fileCap)}`).join("\n\n");
  const recent = history
    .slice(-histN)
    .map((m) => `[${m.role}] ${m.content.slice(0, histCap)}`)
    .join("\n\n");
  return `Q: ${task}

FILES:
${filesBlock}

HISTORY:
${recent || "(none)"}`;
}

/**
 * Estimate token count (rough approximation: ~4 chars per token)
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Caps for hard-trimming user context. Defaults are effectively unlimited unless
 * LLM_CONTEXT_BUDGET=tight or explicit LLM_MAX_* env vars are set.
 */
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

/**
 * Shrink compact context (agent + ask) by trimming HISTORY first, then FILES, then head.
 */
function trimCompactContextMessage(msg: string, maxChars: number): string {
  if (msg.length <= maxChars) return msg;
  const note = "\n\n[…context truncated: shorten the chat or start a new session]";
  const budget = Math.max(400, maxChars - note.length - 20);
  const histKey = "\n\nHISTORY:\n";
  const filesKey = "\n\nFILES:\n";
  const hi = msg.indexOf(histKey);
  const fi = msg.indexOf(filesKey);
  if (fi === -1 || hi === -1 || hi < fi) {
    return msg.slice(0, budget) + note;
  }
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
    filesBlock = cut > 40 ? filesBlock.slice(0, cut) : filesBlock.slice(0, mid);
  }
  let out = head + filesKey + filesBlock + histKey + historyBlock;
  if (out.length > budget) {
    out = out.slice(0, budget);
  }
  return out + note;
}

/**
 * Keeps system + user text under caps when opted in — see clampBudgetEnabled().
 */
export function clampUserMessageToInputBudget(systemPrompt: string, userMsg: string): string {
  if (!clampBudgetEnabled()) return userMsg;
  const maxUser = readMaxUserMessageChars();
  const maxTotal = readMaxTotalPromptChars();
  let u = userMsg;
  if (u.length > maxUser) {
    u = trimCompactContextMessage(u, maxUser);
  }
  while (systemPrompt.length + u.length > maxTotal && u.length > 1200) {
    const room = Math.max(1200, maxTotal - systemPrompt.length - 120);
    u = trimCompactContextMessage(u, room);
  }
  return u;
}

/**
 * Prefer full compact system prompt (few-shot + rules) for best agent quality — like
 * Cursor, not “minimal” mid-conversation. Only use minimal for obvious one-line
 * continuations to save tokens (user can set LLM_DISABLE_MINIMAL_PROMPT=1 to never).
 */
export function selectPromptVersion(task: string, _historyLength: number): "compact" | "minimal" {
  if (process.env.LLM_DISABLE_MINIMAL_PROMPT === "1" || process.env.LLM_DISABLE_MINIMAL_PROMPT === "true") {
    return "compact";
  }
  const t = activeUserTaskSlice(task).trim();
  // One-line “continue” replies only — keeps full instructions for real follow-ups
  if (/^(ok|tiếp|continue|go|do it|làm|làm đi|yes|yep)\s*$/i.test(t)) return "minimal";
  return "compact";
}
