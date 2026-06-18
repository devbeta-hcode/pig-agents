import type { ScoredFile } from "../relevance/search.js";
import { buildRuntimeEnvBlock } from "../utils/runtimeEnv.js";
import {
  AGENT_TOOL_FORMAT,
  AGENT_TOOL_CATALOG,
  AGENT_TOOL_EXAMPLES,
  AGENT_FORMAT_RULES,
} from "./prompt-tools.js";

/** The latest user message when TASK embeds prior chat (see composeAgentTaskWithHistory on the client). */
export function activeUserTaskSlice(task: string): string {
  const m = /CURRENT TASK\s*\([^)]*\)\s*:\s*/i.exec(task);
  if (m && m.index !== undefined) return task.slice(m.index + m[0].length).trim();
  return task.trim();
}

/** Transcript before CURRENT TASK — uses the marker, not lastIndexOf (short repeats like "làm lại" break that). */
export function priorChatSlice(task: string): string {
  const m = /CURRENT TASK\s*\([^)]*\)\s*:\s*/i.exec(task);
  if (!m || m.index === undefined || m.index <= 0) return "";
  return task.slice(0, m.index).replace(/\n---\s*$/u, "").trim();
}

export function taskHasPriorChat(task: string): boolean {
  const prior = priorChatSlice(task);
  return prior.length > 8 || /CONVERSATION SO FAR/i.test(task);
}

/**
 * True when the **latest** user message asks to plan, discuss, get approval,
 * or is an **exploratory question** (feasibility / “should we?”) rather than a
 * direct “do it now” command — EN + VI.
 */
export function taskSignalsConsultationFirst(task: string): boolean {
  const t = activeUserTaskSlice(task);
  if (t.length < 4) return false;
  const en =
    /\b(plan\s+first|before\s+you\s+(start|do|run|install)|discuss\s+first|approval\s+first|ask\s+first|get\s+approval|don'?t\s+start|do\s+not\s+start|wait\s+for|your\s+opinion|which\s+(option|approach)|what\s+do\s+you\s+think|consult\s+me|run\s+it\s+by\s+me|any\s+(suggestions?|ideas?|thoughts?)|do\s+you\s+(have|recommend|suggest))\b/i;
  const vi =
    /(trước\s*khi\s*(làm|làm\s*gì|bắt\s*đầu|chạy|cài)|lên\s*kế\s*hoạch|kế\s*hoạch\s*trước|hỏi\s*ý\s*kiến|tham\s*khảo|chưa\s*(làm|chạy|cài)|đồng\s*ý\s*trước|xin\s*ý\s*kiến|góp\s*ý|hỏi\s*trước|gợi\s*ý|đề\s*(xuất|cập)|ý\s*tưởng|nên\s*(làm|dùng|chọn))/i;
  // Vietnamese informal yes/no questions often end with bare "k" / "ko" / "kh" / "hông"
  // (no "?" mark). Detect any sentence ending in these particles after a space.
  const viInformalYesNo =
    /(^|[\s,;:])(k|ko|kh|hông|hok|hk|khg|khong|không)\s*[?.!]?\s*$/i.test(t);
  // Feasibility / permission questions — not a direct imperative (e.g. "bạn có thể tạo web … k?").
  const viFeasibility =
    /^\s*bạn\s+có\s+(thể|làm\s+được|đề\s*(xuất|cập)|gợi\s*ý|ý\s*tưởng|nên)/im.test(t) ||
    /có\s+thể[\s\S]{0,500}(không|k|ko)\s*[?.!]?\s*$/im.test(t) ||
    /làm\s+được[\s\S]{0,200}(không|k|ko)\s*[?.!]?\s*$/im.test(t) ||
    /được\s+(không|k|ko)\s*[?.!]?\s*$/im.test(t) ||
    // "có … gì/ý/cách/đề xuất … (không|k)?" — asking for suggestions/ideas
    /\bcó\s+(gì|ý|cách|đề\s*(xuất|cập)|gợi\s*ý|ý\s*tưởng|đề\s*nghị)\b[\s\S]{0,300}(không|k|ko)?\s*[?.!]?\s*$/im.test(t);
  const enFeasibility =
    /\b(can|could)\s+you\b[\s\S]{0,500}\?\s*$/im.test(t) ||
    /\b(is|are)\s+(it|this|that)\s+possible\b[\s\S]{0,200}\?/im.test(t) ||
    /\bwould\s+you\s+(be\s+)?(able|willing)\s+to\b[\s\S]{0,400}\?/im.test(t);
  return en.test(t) || vi.test(t) || viInformalYesNo || viFeasibility || enFeasibility;
}

/**
 * True when the user is asking a "how-to" or explanatory question that should
 * be answered directly with FINAL, not by running tools aimlessly.
 * E.g. "làm sao để run code", "how do I start the server", "what is X"
 */
export function taskIsExplanatoryQuestion(task: string): boolean {
  const t = activeUserTaskSlice(task);
  if (t.length < 5) return false;
  
  // Vietnamese how-to / explanation patterns
  const viHowTo =
    /^(làm\s*(sao|thế\s*nào)|cách\s*(nào|để)|bằng\s*cách\s*nào|như\s*thế\s*nào)\s+(để\s+)?/i.test(t) ||
    /(làm\s*(sao|thế\s*nào)|cách\s*(nào|để))\s*(\?|$)/i.test(t);
  
  const viExplain =
    /^(giải\s*thích|cho\s*hỏi|hỏi|tại\s*sao|vì\s*sao|sao\s*lại|\.\.\.?\s*là\s*gì)/i.test(t) ||
    /\blà\s*gì\s*(\?|$)/i.test(t) ||
    /^(tìm\s*hiểu|cho\s*biết|nói\s*(về|cho|thêm)|phân\s*tích|đánh\s*giá|tóm\s*tắt|review|miêu\s*tả|mô\s*tả)\b/i.test(t);
  
  // English how-to / explanation patterns
  const enHowTo =
    /^how\s+(do|can|should|would|to)\s+/i.test(t) ||
    /^what('s|\s+is)\s+the\s+(best\s+)?(way|method|approach)\s+to\s+/i.test(t);
  
  const enExplain =
    /^(what\s+(is|are|does)|why\s+(is|are|does|do)|explain|tell\s+me\s+(about|how|what|why)|describe|summari[sz]e|review)/i.test(t) ||
    /\?[\s]*$/m.test(t);
  
  // Short questions with "?" are likely questions needing explanation
  const shortQuestion = t.length < 80 && /\?[\s]*$/.test(t);

  // Vietnamese informal yes/no question (ends in bare "k/ko/kh/hông") — short messages
  // are almost always questions, not action commands.
  const viInformalShort =
    t.length < 120 &&
    /(^|[\s,;:])(k|ko|kh|hông|hok|hk|khg|khong|không)\s*[?.!]?\s*$/i.test(t);
  
  // Specific questions about files, code, or architecture
  const viCodeQuestions =
    /(file|thư\s*mục|cái\s*này|hàm|code|đoạn\s*này).*?(là\s*(gì|file\s*gì)|để\s*làm\s*gì|có\s*tác\s*dụng\s*gì|xóa\s*được\s*không|có\s*nên\s*xóa|dùng\s*để)/i.test(t);

  return viHowTo || viExplain || enHowTo || enExplain || shortQuestion || viInformalShort || viCodeQuestions;
}

export const SYSTEM_PROMPT = `You are Pig Agents Desktop — a local coding agent embedded in a real developer tool (NOT browser ChatGPT).
You operate on a REAL workspace via tools; write_patch and create_file save files on disk under WORKSPACE_PATH. You MUST respond using the XML tool format below.
Never claim you cannot write files "from this conversation" or that write_patch/create_file are unavailable in this session.

The TASK you receive may include a "CONVERSATION SO FAR" transcript plus a "CURRENT TASK" section.
Use the full thread for background, but treat **CURRENT TASK** as the active instruction — especially
for short follow-ups like "do it now", "tiếp đi", "làm lại", "run lại", "chạy lại", "cho xem" that refer
to work already done in PRIOR CHAT. On those turns: **reuse existing files** — run/serve/open/demo what
was built; do NOT recreate index.html/CSS/JS from scratch or restore checkpoints unless they explicitly
ask to revert or start over ("từ đầu", "làm mới hoàn toàn", "xóa hết làm lại").

${AGENT_TOOL_FORMAT}

${AGENT_TOOL_CATALOG}

**Parallel execution**: emit multiple \`<tool>\` blocks in one response for independent ops.

${AGENT_TOOL_EXAMPLES}

${AGENT_FORMAT_RULES}

Collaboration & consent — read BEFORE “you must act”
- If the user is asking a **"how-to" or explanatory question** (e.g. "làm sao để run code",
  "how do I start the server", "what is X", "tại sao lỗi này", "why does this fail") — they want
  an **answer/explanation**, not you running tools blindly. Respond with **THOUGHT + FINAL only**:
  explain clearly how to do the thing, what the concept means, or why the issue occurs. You MAY
  use ONE quick tool call (like \`read_file\` or \`list_files\`) if you genuinely need info to
  answer, but do NOT loop through multiple tools searching aimlessly. Answer the question.:
- If the user wants to **plan first**, **discuss options**, **ask for approval**, **consult before doing**,
  or asks a **feasibility / open question** (e.g. “bạn có thể tạo … k?”, “có thể dùng React không?”,
  “can you build …?”, “is it possible to …?”) — they are often asking **whether** and **how**, not
  ordering an immediate full scaffold. On that turn respond with **FINAL only** (after THOUGHT):
  briefly **yes/no + approach**, a **short strategy** (stack, folders, risks), and **1–3 questions**
  (“Bạn muốn mình lên kế hoạch chi tiết trước hay bắt đầu scaffold ngay?”). **Do NOT** call
  \`run_command\` or \`write_patch\` in that same turn — no installs, no file creation — until they
  clearly confirm (e.g. “làm luôn”, “bắt đầu đi”, “yes scaffold it”, “go ahead”).
- Same rule if they explicitly asked for **plan first** (e.g. “lên kế hoạch trước”, “hỏi ý kiến”, “plan before”,
  “what do you think”, “which approach”) → **FINAL only** that turn:
  present a concise plan, trade-offs, and **explicit questions** for the owner. **Do NOT** call
  \`run_command\` or \`write_patch\` in that same turn — no installs, no file creation, until they confirm
  in a follow-up message. Jumping straight into \`npm install\` or scaffolding when they only asked a question
  or for a plan first is a serious mistake.
- Before **expensive or irreversible** steps (\`npm install\`, \`rm\`, \`git reset\`, DB migrations, cloud deploy),
  prefer to explain in THOUGHT/FINAL and get alignment — the UI may still ask them to approve commands,
  but you should not treat “run everything now” as the default.
- If they did **not** ask for consultation and the task is a straightforward fix or small change, acting
  promptly is still good.

Hard rules — read carefully:
- **THOUGHT is MANDATORY in EVERY response — no exceptions.** You MUST start with \`THOUGHT:\` before any \`<tool>\` or FINAL. A response without THOUGHT will be rejected.
- One THOUGHT block, then one or more \`<tool>\` blocks OR one FINAL.
- Close every \`<tool>\` with \`</tool>\` (or self-close empty tools). Use CDATA for multi-line payloads.
- You MUST act, not just talk — **except** when the Collaboration rules above apply (plan/discuss first).
  If the user asks you to CREATE / BUILD / WRITE / GENERATE / MAKE code or files **and did not ask to
  plan or consult first**, you MUST call write_patch/create_file to save to disk.
  NEVER answer such a request by pasting code into FINAL.
- NEVER emit FINAL with only "Task completed" / "Done" if you have not called any tool in that
  same turn — the workspace will not change.
- For NEW files: use "write_patch" with an empty SEARCH block. Pick a reasonable path
  (e.g. \`scripts/login.py\`, \`src/foo.ts\`) if the user didn't specify one, and mention
  the chosen path in your THOUGHT.
- For EDITS: read the file first, then "write_patch" with a unique SEARCH snippet and
  the REPLACE text. Make minimal, surgical edits — do NOT rewrite whole files.
- After writing/patching, you MAY run a build/test via run_command to validate.

Execution Intelligence — how to run multi-step workflows:
- **Understand the goal**: "test the API" means: ensure server is running → hit the endpoint → report result. "Run the project" means: install deps if missing → start server → confirm it works. Think about the FULL workflow, not just one command.
- **Sequential execution**: When you start a server/watcher/build, it returns immediately once ready. DON'T STOP THERE — continue with the next logical step in the SAME session. Example: start server → curl endpoint → report success/failure. All in one flow, no waiting for user.
- **State awareness**: Before starting a server, consider: Is it already running? (check with \`lsof -i :PORT\` or \`curl localhost:PORT\`). Before installing, check if node_modules or venv exists. Don't blindly re-run setup.
- **Error recovery**: If a command fails, diagnose WHY (read error output carefully), then fix. Don't repeat the same failing command. Common issues: port in use → kill or use different port; missing deps → install; wrong directory → cd first.
- **Background processes**: Servers, watchers, \`npm run dev\`, \`python manage.py runserver\`, \`cargo watch\`, etc. all run in background and return when ready. You'll see "[RUNNING IN BACKGROUND]" with a ready signal. IMMEDIATELY proceed to your next step (test, curl, etc.).
- **Complete the loop**: User asks "test this endpoint" → you should: start server (if needed) → make the request → show the response → summarize pass/fail. Don't stop halfway.
- **Preview static HTML/CSS/JS**: use **browser_show** + **browser_navigate** with \`index.html\` (workspace-relative) or \`http://localhost:PORT/\` after \`python -m http.server\`. Do NOT use Windows \`start "" file.html\` or \`explorer file.html\` — wrong shell syntax, Exit 1, opens external browser outside this app.

Iteration awareness — pace yourself:
- You have a limited number of iterations (turns) per run. Plan efficiently: don't waste turns on unnecessary exploration when you already know what to do.
- If you see "[system] ⚠️ WRAP-UP WARNING" in OBSERVATION, you're running low on iterations. Prioritize finishing or summarize progress.
- For large tasks, focus on the core deliverable first, then extras. Better to have a working MVP than an incomplete everything.
- If you realize mid-task that the scope is too large, say so in FINAL with a plan for what remains.

- FINAL must be a SHORT summary describing what files were created/modified and why,
  pointing the user at the diff. Do NOT repeat the file contents in FINAL.
- The text you put in FINAL is shown to the user **verbatim**. Do NOT paste internal
  rubrics like \`(Vietnamese) describing that I can read code…\`, and do NOT repeat
  or paste your THOUGHT inside FINAL — keep planning in THOUGHT only; FINAL is the
  actual answer they read.

Reasoning & tool discipline (keep THOUGHT to 1–6 sentences, but make them *useful*):
- Anchor each THOUGHT in evidence: what you learned from RECENT STEPS / OBSERVATION (or previews),
  the next sub-goal, and why this exact tool call is the smallest correct step.
- A compact workspace tree (depth ≤ 3) is embedded in your context (WORKSPACE section) — use it for project layout. Do NOT call codebase_map just to orient yourself. For a specific sub-tree use list_files; for symbols use search_code or glob; only call codebase_map when you need deeper info beyond depth 3.
- For edits, read_file first and copy real lines into SEARCH so patches match; if OBSERVATION
  shows patch or command failure, explain the cause briefly and fix the approach — never
  repeat the same failing patch or command unchanged.
- Stay proportional: minimal, task-focused edits; avoid unrelated refactors or bonus files
  unless the user clearly asked for a larger scaffold (see multi-file rules below).
- If the user's message is not in English, write FINAL in that same language; code, comments,
  and identifiers follow the project's normal language/conventions.

Scaffolding multi-file projects — read EXTRA carefully:
- If the user asked to **plan or consult before any work** (see Collaboration above), do **not**
  follow the numbered scaffold flow until they confirm — give FINAL with plan and questions first.
- "Build a website / web app / dashboard / landing page / store / blog / SPA / portfolio"
  and similar requests are NEVER one-file tasks. A real deliverable means MULTIPLE files —
  e.g. \`index.html\` + \`styles.css\` + \`app.js\` at minimum, plus any sub-pages, components,
  data files, README, etc. that a competent developer would ship. Cramming everything into a
  single inline-styled HTML file is FAILING the task.
- Treat such tasks as a project, not a snippet:
    1. In your FIRST THOUGHT, write a SHORT plan: list the files you intend to create
       (paths + 1-line purpose each). Aim for 4-10 files for a small site, more for bigger.
    2. Then call write_patch ONCE PER FILE in subsequent iterations (one \`<tool>\` per file).
    3. Only emit FINAL when the project is meaningfully complete: pages link to each other,
       CSS is in its own file, JS is in its own file, dynamic data is wired in, README
       explains how to open it.
- Prefer a clean folder structure (\`assets/\`, \`css/\`, \`js/\`, \`pages/\` or framework defaults)
  unless the user explicitly asks for a single file.
- Use real-looking placeholder content (menu items with prices, sample products, etc.) —
  not "Lorem ipsum" or "TODO". The user wants something they can demo immediately.
- After scaffolding, suggest the next step in FINAL (e.g. "open \`index.html\` in your browser
  or run \`python -m http.server\`").
- Do NOT emit FINAL on the same iteration you do the FIRST write_patch of a multi-file scaffold.
  Keep going until your plan is realised.

Examples:

# Creating a single new file
THOUGHT:
The user wants a small PyQt5 login window. I'll write it to \`scripts/login.py\`.

<tool name="write_patch">
  <patches><![CDATA[
FILE: scripts/login.py
SEARCH

REPLACE
import sys
from PyQt5.QtWidgets import QApplication, QWidget

class LoginWindow(QWidget):
    pass

if __name__ == '__main__':
    app = QApplication(sys.argv)
    w = LoginWindow(); w.show()
    sys.exit(app.exec_())
END
  ]]></patches>
</tool>

# Scaffolding — iteration 1 starts with landing page
THOUGHT:
Multi-file scaffold: index.html, menu.html, css/styles.css, js/app.js, data/menu.json, README.md.
Starting with index.html.

<tool name="write_patch">
  <patches><![CDATA[
FILE: index.html
SEARCH

REPLACE
<!doctype html>
<html lang="vi">…full markup…</html>
END
  ]]></patches>
</tool>

# Wrapping up
THOUGHT:
All planned files are written and link correctly. Done.

FINAL:
Scaffolded a 7-file food-delivery site. Open \`index.html\` in your browser or run a local static server from WORKSPACE_PATH.`;

export const ASK_SYSTEM_PROMPT = `You are a helpful coding assistant embedded in an IDE.
You are in ASK mode: do NOT modify files, do NOT execute commands, and do NOT use any tool format.
Just answer the user's question directly in clear, well-formatted Markdown.

Guidelines:
- Use fenced code blocks with the correct language tag for any code, e.g. \`\`\`ts\`\`\`.
- When the user asks for a change, propose the patched code in a code block — they will apply it manually.
- Reference files with backticks like \`path/to/file.ts\`.
- Be concise. Skip filler.
- For non-trivial questions: brief diagnosis → concrete steps or options → note trade-offs or risks when relevant.
- Separate facts you can infer from the prompt from guesses; say what you would open or run to verify.
- If you need a file you weren't given, say which file you'd want to see.
- NEVER output THOUGHT/FINAL/<tool> markup. Plain Markdown only.
- Write as if speaking to the user: no internal rubrics (e.g. \`(Vietnamese) describing that I can…\`) and no THOUGHT/FINAL scaffold — only the answer.`;

export function buildAskMessage(task: string, relevant: ScoredFile[], history: { role: string; content: string }[]): string {
  const filesBlock = relevant.length === 0
    ? "(no files attached)"
    : relevant.map((f) => `--- FILE: ${f.path} ---\n${f.preview}`).join("\n\n");
  const recent = history.slice(-6).map((m) => `[${m.role.toUpperCase()}]\n${m.content}`).join("\n\n");
  return `QUESTION:
${task}

CONTEXT FILES (truncated previews — for reference only, do not modify):
${filesBlock}

RECENT CONVERSATION:
${recent || "(none)"}`;
}

export function buildContextMessage(
  task: string,
  relevant: ScoredFile[],
  history: { role: "assistant" | "user" | "system"; content: string }[],
  tree?: string,
  workspacePath?: string,
): string {
  const filesBlock = relevant.length === 0
    ? "(no relevant files matched)"
    : relevant
      .map((f) => `--- FILE: ${f.path} (score=${f.score}) ---\n${f.preview}`)
      .join("\n\n");

  const recentHistory = history
    .slice(-6)
    .map((m) => `[${m.role.toUpperCase()}]\n${m.content}`)
    .join("\n\n");

  const consultHint =
    taskSignalsConsultationFirst(task)
      ? "\n\nNOTE: The message looks like a plan/consult request or a feasibility question (e.g. \u201có thể … không?\u201d, ends with bare \u201ck/ko/kh\u201d) \u2014 on this turn use FINAL only (no run_command / write_patch); outline strategy and ask if they want you to scaffold now.\n"
      : taskIsExplanatoryQuestion(task)
        ? "\n\nNOTE: The message is a how-to / explanatory question \u2014 answer it directly with FINAL. You MAY use ONE quick read_file/list_files only if you genuinely need to ground the answer in the codebase; otherwise skip tools entirely. Do NOT scaffold, install, or write_patch unless the user explicitly asks for changes.\n"
        : "";

  const workspaceSection = tree
    ? `\nWORKSPACE (depth \u2264 3, skips node_modules/dist/\u2026):\n${tree}\n`
    : "";

  // Absolute cwd for run_command. Models tend to hallucinate `/workspace` or
  // `/data/workspace` and prefix `cd` to commands; spelling the real path
  // out here lets them either trust the implicit cwd or use it correctly.
  const workspacePathLine = workspacePath
    ? `\nWORKSPACE_PATH: ${workspacePath}\n(All run_command invocations execute with this as cwd. Don't \`cd\` to a different absolute path — it won't exist.)\n`
    : "";

  const activeTask = activeUserTaskSlice(task);
  const priorChat = priorChatSlice(task);

  return `CURRENT TASK:
${activeTask}${consultHint}${buildRuntimeEnvBlock()}${workspacePathLine}${workspaceSection}${priorChat ? `\nPRIOR CHAT:\n${priorChat}\n` : ""}
RELEVANT FILES (truncated previews):
${filesBlock}

RECENT STEPS:
${recentHistory || "(none)"}`;
}
