import { activeUserTaskSlice } from "../llm/prompt-compact.js";

/** User wants a multi-file scaffold (website, app, …) — not a surgical fix. */
export function looksLikeScaffoldTask(task: string): boolean {
  const t = activeUserTaskSlice(task).toLowerCase();
  const verbs =
    /\b(build|create|make|scaffold|generate|write|develop|design|code|xay|xaay|xây|tao|tạo|viet|viết|làm|lam)\b/;
  const subjects =
    /\b(web ?site|web ?app|webapp|landing( page)?|portfolio|blog|store|shop|dashboard|admin panel|spa|app|application|game|platform|saas|crud|todo app|chat app|booking|delivery|ecommerce|e-?commerce|marketplace|cms|forum|wiki|trang web|website|ứng ?dụng|ung ?dung)\b/;
  return verbs.test(t) && subjects.test(t);
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

/** Short hint injected into agent context (CURRENT TASK). */
export function taskShapeContextHint(task: string): string {
  if (taskSignalsConsultationOnly(task)) return "";
  if (looksLikeLocalizedFixTask(task)) {
    const paths = pathsMentionedInTask(task);
    const pathNote = paths.length ? ` Target: ${paths.slice(0, 3).join(", ")}.` : "";
    return `\n[efficiency: localized fix — read/search first, then minimal write_patch in existing file(s); do NOT create extra files unless user asked.${pathNote}]`;
  }
  if (looksLikeScaffoldTask(task)) {
    return "\n[efficiency: multi-file deliverable — plan files in THOUGHT, then write each; avoid one giant file.]";
  }
  return "\n[efficiency: smallest change that solves the task; avoid new files and redundant reads.]";
}

function taskSignalsConsultationOnly(task: string): boolean {
  const t = activeUserTaskSlice(task);
  if (/\b(plan\s+first|lên\s*kế\s*hoạch|hỏi\s*ý\s*kiến)\b/i.test(t)) return true;
  if (/có\s+thể[\s\S]{0,200}(không|k|ko)\s*[?.!]?\s*$/im.test(t)) return true;
  if (/^(làm\s*sao|cách\s*nào|how\s+(do|can|to)\s+)/i.test(t)) return true;
  return false;
}
