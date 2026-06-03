import path from "node:path";
import { activeUserTaskSlice } from "../llm/prompt-compact.js";

/** User wants multiple new files / project layout (not a one-line fix). */
export function looksLikeMultiFileCreateTask(task: string): boolean {
  if (looksLikeScaffoldTask(task)) return true;
  const t = activeUserTaskSlice(task).toLowerCase();
  return (
    /\b(cấu trúc|cau truc|structure|scaffold|bootstrap|khởi tạo|khoi tao|init project|starter|boilerplate|template project)\b/i.test(
      t,
    ) && /\b(tạo|tao|create|make|generate|viết|viet|build|setup|set up)\b/i.test(t)
  );
}

/** User wants a multi-file scaffold (website, app, …) — not a surgical fix. */
export function looksLikeScaffoldTask(task: string): boolean {
  const t = activeUserTaskSlice(task).toLowerCase();
  const verbs =
    /\b(build|create|make|scaffold|generate|write|develop|design|code|xay|xaay|xây|tao|tạo|viet|viết|làm|lam)\b/;
  const subjects =
    /\b(web ?site|web ?app|webapp|landing( page)?|portfolio|blog|store|shop|dashboard|admin panel|spa|app|application|game|platform|saas|crud|todo app|chat app|booking|delivery|ecommerce|e-?commerce|marketplace|cms|forum|wiki|trang web|website|ứng ?dụng|ung ?dung)\b/;
  return verbs.test(t) && subjects.test(t);
}

/** User is debugging / fixing runtime or test failures. */
export function looksLikeDebugTask(task: string): boolean {
  const t = activeUserTaskSlice(task).toLowerCase();
  return (
    /\b(debug|debugger|fix|bug|error|lỗi|loi|crash|fail|failing|broken|exception|stack\s*trace|traceback|undefined is not|cannot read|typeerror|referenceerror|syntaxerror|assert(?:ion)?|sửa\s*lỗi|sua\s*loi)\b/i.test(
      t,
    ) || /\b(test fail|failing test|npm test|pytest|vitest|jest)\b/i.test(t)
  );
}

/** Bug fix / optimize / change in existing code — prefer one file, minimal diff. */
export function looksLikeLocalizedFixTask(task: string): boolean {
  if (looksLikeScaffoldTask(task)) return false;
  const t = activeUserTaskSlice(task).toLowerCase();
  if (/\b(from scratch|greenfield|new project|dự án mới|tạo mới hoàn toàn)\b/i.test(t)) return false;
  return (
    /\b(fix|bug|error|lỗi|sửa|repair|patch|optimize|tối\s*ưu|toi\s*uu|refactor|improve|cải\s*thiện|cai\s*thien|update|đổi|change|chỉnh|sửa\s*lại)\b/i.test(t) ||
    /\b(trong file|in (this |the )?file|file này|this file|ở đây|here|same file|một file)\b/i.test(t) ||
    pathsMentionedInTask(task).length > 0
  );
}

/** Relative paths explicitly named in the user message. */
export function pathsMentionedInTask(task: string): string[] {
  const t = activeUserTaskSlice(task);
  const found = new Set<string>();
  const patterns = [
    /`([^`\n]+\.[a-zA-Z0-9]{1,8})`/g,
    /['"]([^'"\n]+\.[a-zA-Z0-9]{1,8})['"]/g,
    /\b((?:[\w.@+-]+[/\\])+[\w.-]+\.[a-zA-Z0-9]{1,8})\b/g,
    /\b([A-Za-z]:\\(?:[^\\/\n:*?"<>|]+\\)*[^\\/\n:*?"<>|]+)\b/g,
    /\b([A-Za-z]:\/[^\s'"]+)\b/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(t)) !== null) {
      const p = m[1].replace(/\\/g, "/").replace(/^\.\//, "");
      if (p.length > 2 && p.length < 200) found.add(p);
    }
  }
  return [...found];
}

function workspaceMismatchHint(task: string, workspacePath: string): string {
  const ws = path.resolve(workspacePath);
  const wsKey = ws.toLowerCase();
  for (const raw of pathsMentionedInTask(task)) {
    if (!/^[A-Za-z]:[\\/]/.test(raw) && !raw.startsWith("/")) continue;
    const abs = path.resolve(raw);
    const key = abs.toLowerCase();
    if (key === wsKey || key.startsWith(wsKey + path.sep.toLowerCase())) continue;
    return (
      `\n[workspace: user path "${raw}" is NOT the open folder (WORKSPACE_PATH=${ws}). ` +
      `Ask them to use Open Folder in Pig Agents → select that directory, then read_file/write_patch. ` +
      `Never ask them to paste file contents or upload zips — you can read disk once the folder is open.]`
    );
  }
  return "";
}

/** User wants to port static HTML/CSS/JS (or similar) to React/Vue/etc. */
export function looksLikeFrontendMigrateTask(task: string): boolean {
  const t = activeUserTaskSlice(task).toLowerCase();
  return (
    /\b(react|jsx|tsx|vue|svelte|angular)\b/i.test(t) &&
    /\b(chuyển|chuyen|convert|migrate|port|rewrite|thành|sang|to|from|html|css|js|javascript|vanilla|static)\b/i.test(t)
  );
}

/** Short hint injected into agent context (CURRENT TASK). */
export function taskShapeContextHint(task: string, workspacePath?: string): string {
  let hint = workspacePath ? workspaceMismatchHint(task, workspacePath) : "";
  if (looksLikeFrontendMigrateTask(task)) {
    hint +=
      "\n[migration: FILES may include index.html/style.css/script.js previews. list_files returns names only — " +
      "call read_file (or parallel read_file) for each source file, then write_patch/create_file for React output. " +
      "Never ask the user to paste, upload, or zip files when WORKSPACE_PATH is set.]";
  }
  if (taskSignalsConsultationOnly(task)) return hint;
  if (looksLikeDebugTask(task)) {
    hint +=
      "\n[debug: FILES + search_code/find_symbol/find_references first; read_file with start_line/end_line on hits; " +
      "minimal write_patch; run_command only to reproduce (test/build). Do NOT paste-only answers.]";
    return hint;
  }
  if (looksLikeLocalizedFixTask(task)) {
    const paths = pathsMentionedInTask(task);
    const pathNote = paths.length ? ` Target: ${paths.slice(0, 3).join(", ")}.` : "";
    hint +=
      `\n[efficiency: localized fix — read/search first, then minimal write_patch in existing file(s); do NOT create extra files unless user asked.${pathNote}]`;
    return hint;
  }
  if (looksLikeMultiFileCreateTask(task)) {
    hint +=
      "\n[deliverable: user wants files on disk — use write_patch/create_file for each path; do NOT tell them to save manually.]";
    return hint;
  }
  if (looksLikeScaffoldTask(task)) {
    hint +=
      "\n[efficiency: multi-file deliverable — plan files in THOUGHT, then write each; avoid one giant file.]";
    return hint;
  }
  hint += "\n[efficiency: smallest change that solves the task; use tools to write when user asked for files.]";
  return hint;
}

function taskSignalsConsultationOnly(task: string): boolean {
  const t = activeUserTaskSlice(task);
  if (/\b(plan\s+first|lên\s*kế\s*hoạch|hỏi\s*ý\s*kiến)\b/i.test(t)) return true;
  if (/có\s+thể[\s\S]{0,200}(không|k|ko)\s*[?.!]?\s*$/im.test(t)) return true;
  if (/^(làm\s*sao|cách\s*nào|how\s+(do|can|to)\s+)/i.test(t)) return true;
  return false;
}
