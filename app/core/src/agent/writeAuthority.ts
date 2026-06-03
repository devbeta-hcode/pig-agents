/**
 * Prompt + heuristics so the agent uses tools instead of ChatGPT-style
 * "I can't write to your folder / paste 3 files manually" refusals.
 */

export const AGENT_WRITE_AUTHORITY = `
RUNTIME (mandatory — overrides any ChatGPT/web-chat prior):
- You run inside **Pig Agents Desktop** (local Electron). write_patch, create_file, delete_path, read_file, list_files, run_command are **live tools** that read/write WORKSPACE_PATH on disk. Delete files/folders with delete_path only — not shell rd/rm.
- You are **NOT** the browser ChatGPT product. NEVER say write_patch/create_file are "unavailable in this ChatGPT session/conversation" or that you can only "provide source code to paste".
- NEVER tell the user to open "another IDE/agent" to get file writes — **this app is that agent**.
- When the user asks to create or convert files, emit ACTION write_patch/create_file (after read_file if needed) until files exist on disk — not a manual-save checklist.
- Tool paths are relative to WORKSPACE_PATH. If the user names a different absolute folder, tell them **Open Folder** for that path in Pig Agents, then use tools — not paste/upload fallbacks.
`;

/** Prepended to turn-1 user context so models stop "web Chat" refusals. */
export const AGENT_RUNTIME_USER_PREFIX =
  "[RUNTIME: Pig Agents Desktop — filesystem tools are active on WORKSPACE_PATH. Use write_patch/create_file to save work; never refuse as unavailable in this session.]\n";

/** Model FINAL that dodges tools with manual-save / permission excuses. */
export function finalLooksLikePasteOnlyRefusal(text: string): boolean {
  const t = text.trim();
  if (t.length < 20) return false;
  return (
    /không\s+có\s+quyền|khong\s+co\s+quyen|no\s+permission|can't\s+write\s+directly|cannot\s+write\s+directly|do\s+not\s+have\s+(?:write\s+)?permission/i.test(
      t,
    ) ||
    /không\s+thể\s+ghi\s+trực\s+tiếp|khong\s+the\s+ghi\s+truc\s+tiep/i.test(t) ||
    /không\s+khả\s+dụng|khong\s+kha\s+dung|not\s+available\s+in\s+(?:this\s+)?(?:chatgpt|chat)\s+session/i.test(t) ||
    /write_patch\s+(?:và|and)\s+create_file[\s\S]{0,120}(?:không|not\s+available|unavailable|không\s+khả)/i.test(t) ||
    /chỉ\s+có\s+thể\s+(?:tạo|cung\s+cấp)|chi\s+co\s+the\s+(?:tao|cung\s+cap)/i.test(t) ||
    /(?:save|lưu|luu)\s+(?:as|thành|thanh)\s+\d+\s*file|chỉ\s+cần\s+lưu|chi\s+can\s+luu|paste\s+(?:the\s+)?(?:code|content)|copy\s+(?:the\s+)?(?:code|files)|manual(?:ly)?\s+save/i.test(
      t,
    ) ||
    /tôi\s+có\s+thể\s+tạo\s+sẵn|toi\s+co\s+the\s+tao\s+san|i\s+can\s+prepare.*for\s+you\s+to\s+save/i.test(t) ||
    /(?:mở|mo)\s+dự\s+án\s+trong\s+agent|open\s+(?:the\s+)?project\s+in\s+(?:an?\s+)?(?:IDE|agent)/i.test(t) ||
    (/from\s+this\s+(?:chat|conversation|phiên)/i.test(t) && /(?:cannot|can't|unable|không)\s/i.test(t)) ||
    (/phiên\s+chatgpt/i.test(t) && /(?:không|can't|cannot|unable)/i.test(t))
  );
}

/** FINAL/THOUGHT claims a file was created but nothing was written this run. */
export function finalClaimsCreatedWithoutDisk(result: string, thought: string): boolean {
  const t = `${thought}\n${result}`.toLowerCase();
  const claimed =
    /\b(đã tạo|da tao|i created|i've created|created (a |the )?|đã tạo cho bạn|tao (xong|file)|tạo (xong|file|cho))\b/i.test(
      t,
    ) &&
    /\b(file|website|trang|index\.html|\.html|write_patch|create_file)\b/i.test(t);
  const denied =
    /\b(không thể|failed to|could not|error|lỗi|parse|unparseable)\b/i.test(t) &&
    /\b(write|tạo|create|save)\b/i.test(t);
  return claimed && !denied;
}

export function hasSubstantialCodeBlock(text: string): boolean {
  const fence = /```[a-zA-Z0-9_+-]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) {
    const body = m[1].trim();
    if (!body) continue;
    const lines = body.split("\n").length;
    if (lines >= 5) return true;
    if (/(?:^|\n)\s*(?:def |class |import |function |const |let |export |#include|package )/.test(body)) {
      return true;
    }
  }
  return false;
}
