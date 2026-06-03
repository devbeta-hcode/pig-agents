export type AgentStep =
  | { kind: "action"; thought: string; type: string; input: Record<string, unknown> }
  | { kind: "multi_action"; thought: string; actions: Array<{ type: string; input: Record<string, unknown> }> }
  | { kind: "final"; thought: string; result: string }
  | { kind: "error"; raw: string; error: string };

import { extractDsmlToolCalls } from "./dsmlTools.js";
import { actionScheduleKey } from "./actionKey.js";

/**
 * Some models (DeepSeek, Qwen variants) emit XML-style tags instead of the
 * ReAct `THOUGHT:` / `ACTION:` / `FINAL:` markers. Normalize those upfront so
 * the rest of the parser keeps working — without this we'd silently drop every
 * `<action>` after the first and the whole blob lands in the THOUGHT body.
 */
function normalizeXmlTags(text: string): string {
  let out = text;
  out = out.replace(/<\s*thought\s*>\s*/gi, "\nTHOUGHT: ");
  out = out.replace(/<\s*\/\s*thought\s*>\s*/gi, "\n");
  out = out.replace(/<\s*action\s*>\s*/gi, "\nACTION: ");
  out = out.replace(/<\s*\/\s*action\s*>\s*/gi, "\n");
  out = out.replace(/<\s*final\s*>\s*/gi, "\nFINAL: ");
  out = out.replace(/<\s*\/\s*final\s*>\s*/gi, "\n");
  return out;
}

/** Models often glue `}THOUGHT:` or `END"}THOUGHT:` with no newline — breaks extractBlock. */
export function normalizeReActBoundaries(text: string): string {
  let out = text.replace(/\r\n/g, "\n");
  out = out.replace(/(\})\s*(THOUGHT|ACTION|FINAL):/gi, "$1\n$2:");
  out = out.replace(/(<\/\|DSML\|invoke>)\s*(THOUGHT|ACTION|FINAL):/gi, "$1\n$2:");
  out = out.replace(/END"\s*\}\s*(THOUGHT|ACTION|FINAL):/gi, 'END"}\n$1:');
  return out;
}

function normalizeAgentText(text: string): string {
  return normalizeReActBoundaries(normalizeXmlTags(text));
}

/** True when every FILE: block in a write_patch payload has a closing END line. */
export function writePatchPayloadLooksComplete(patches: string): boolean {
  const t = patches.replace(/\r\n/g, "\n").trim();
  if (!t) return false;
  if (!/^FILE:/m.test(t)) return /\nREPLACE\n[\s\S]*\nEND\s*$/m.test(t) || /\nREPLACE\n/.test(t);
  const parts = t.split(/(?=^FILE:)/m).filter((p) => p.trim().startsWith("FILE:"));
  if (parts.length === 0) return false;
  return parts.every((seg) => /\nEND\s*$/m.test(seg.trim()) || /\nEND\n/.test(seg));
}

function parseJsonObjectByBraceDepth(frag: string): { json: Record<string, unknown>; end: number } | null {
  if (!frag.trimStart().startsWith("{")) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < frag.length; i++) {
    const c = frag[i];
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
      if (depth === 0) {
        const slice = frag.slice(0, i + 1);
        const json = tryParseJson(slice);
        if (json) return { json, end: i + 1 };
        return null;
      }
    }
  }
  return null;
}

function actionFromJsonRecord(json: Record<string, unknown>): { type: string; input: Record<string, unknown> } | null {
  if (typeof json.type === "string") {
    const step = parsedJsonToAction(json, "", "");
    if (step.kind === "action") return { type: step.type, input: step.input };
    return null;
  }
  if (typeof json.patches === "string") {
    return { type: "write_patch", input: { patches: json.patches } };
  }
  return null;
}

function extractBlock(text: string, label: string): string | null {
  // Accept both "LABEL:\ncontent" and "LABEL: content" (some models emit either form).
  const re = new RegExp(`(?:^|\\n)${label}:[ \\t]*\\n?([\\s\\S]*?)(?=\\n(?:THOUGHT|ACTION|FINAL):|$)`, "i");
  const m = re.exec(text);
  return m ? m[1].trim() : null;
}

function tryParseJson(s: string): Record<string, unknown> | null {
  // First try direct parse
  try { return JSON.parse(s); } catch { /* fallthrough */ }
  
  // Extract JSON object from text
  const m = /\{[\s\S]*\}/.exec(s);
  if (m) {
    let jsonStr = m[0];
    
    // Try direct parse first
    try { return JSON.parse(jsonStr); } catch { /* fallthrough */ }
    
    // Some models output literal \n instead of actual newlines in strings
    // e.g. "input":"FILE:x.json\nSEARCH\n..." where \n is two chars, not newline
    // This is INVALID JSON but we can try to fix it
    try {
      // Replace literal \n (two chars) inside string values with actual newline
      // But be careful not to break already-escaped \\n
      const fixed = jsonStr.replace(/\\n/g, '\n');
      return JSON.parse(fixed);
    } catch { /* fallthrough */ }
    
    // Try treating the whole thing as having literal escapes
    try {
      // Handle case where model outputs: "input":"FILE:...\nSEARCH..."
      // The \n here should be actual newline for JSON to be valid
      const reFixed = jsonStr.replace(/([^\\])\\n/g, '$1\n').replace(/^\\n/, '\n');
      return JSON.parse(reFixed);
    } catch { /* fallthrough */ }
  }
  return null;
}

/**
 * Models often emit create_file with raw HTML (unescaped `"` in lang="vi") — invalid JSON.
 * Recover path + body when we can see <!DOCTYPE or <html in the ACTION fragment.
 */
function salvageCreateFileFromFragment(
  frag: string,
  opts?: { requireClosingHtml?: boolean },
): { type: string; input: Record<string, unknown> } | null {
  if (!/"type"\s*:\s*"create_file"/i.test(frag)) return null;
  const pathM = /"path"\s*:\s*"([^"\\]+)"/i.exec(frag);
  if (!pathM) return null;
  const path = pathM[1];
  const htmlStart = frag.search(/<!DOCTYPE\s+html|<html[\s>]/i);
  if (htmlStart < 0) return null;
  const closeIdx = frag.search(/<\/html>/i);
  if (opts?.requireClosingHtml && closeIdx < 0) return null;
  let end = closeIdx;
  end = end >= 0 ? end + "</html>".length : frag.length;
  let content = frag.slice(htmlStart, end).trim();
  content = content.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  content = content.replace(/"\s*}\s*}\s*$/, "").trim();
  if (content.length < 20) return null;
  return { type: "create_file", input: { path, content } };
}

function actionFromActionFragment(frag: string): { type: string; input: Record<string, unknown> } | null {
  const json = tryParseJson(frag);
  if (json) {
    const fromJson = actionFromJsonRecord(json);
    if (fromJson) return fromJson;
  }
  return salvageCreateFileFromFragment(frag);
}

/** If the whole chunk is one ``` / ```json fenced block, strip fences so JSON.parse works. */
function stripOptionalMarkdownFence(s: string): string {
  const t = s.trim();
  const m = t.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  return m ? m[1].trim() : s;
}

/** Model often wraps tools in markdown fences — try each fenced segment before greedy `{…}` scan. */
function* fencedJsonSegments(fullText: string): Generator<string> {
  const re = /```(?:json)?\s*\n([\s\S]*?)```/gi;
  let match;
  while ((match = re.exec(fullText)) !== null) {
    yield match[1].trim();
  }
}

function parsedJsonToAction(
  json: Record<string, unknown>,
  thoughtPrefix: string,
  textForFallbackThought: string,
): AgentStep {
  let input: Record<string, unknown>;
  if (json.input && typeof json.input === "object") {
    input = json.input as Record<string, unknown>;
  } else if (typeof json.input === "string") {
    if (json.type === "write_patch") {
      input = { patches: json.input };
    } else if (json.type === "read_file") {
      input = { path: json.input };
    } else if (json.type === "delete_path" || json.type === "delete_file") {
      input = { path: json.input };
    } else if (json.type === "list_files") {
      input = { dir: json.input };
    } else if (json.type === "search_code") {
      input = { query: json.input };
    } else if (json.type === "run_command") {
      input = { cmd: json.input };
      if (json.background) input.background = true;
    } else {
      input = { value: json.input };
    }
  } else {
    input = {};
  }
  const thought =
    thoughtPrefix || (textForFallbackThought.split(/\{/)[0] || "").trim();
  return { kind: "action", thought, type: json.type as string, input };
}

/**
 * Try to detect tool intent from natural language output.
 * This helps when models don't follow strict ReAct format.
 */
function detectToolIntent(text: string): { type: string; input: Record<string, unknown> } | null {
  const norm = normalizeAgentText(text);
  // ReAct / bare tool JSON — never scrape FILE:/SEARCH from THOUGHT or glued patch JSON.
  if (/(?:^|\n)(?:THOUGHT|ACTION|FINAL):\s*/im.test(norm)) return null;
  if (/^\s*\{\s*"(?:type|patches)"/m.test(norm.trimStart())) return null;

  const lower = norm.toLowerCase();
  
  // Detect write_patch intent first (most important after lazy-final nudge)
  // Patterns: SEARCH/REPLACE blocks, "write to file", "create file", code blocks with file paths
  const searchReplaceMatch = norm.match(/FILE:\s*([^\n]+)\s*\nSEARCH\n/i);
  if (searchReplaceMatch) {
    const patchStart = norm.indexOf("FILE:");
    if (patchStart !== -1) {
      const patches = norm.slice(patchStart).trim();
      if (!writePatchPayloadLooksComplete(patches)) return null;
      return { type: "write_patch", input: { patches } };
    }
  }
  
  // Detect write intent from "writing to X", "create X file", "save to X"
  const writeMatch = norm.match(/(?:write|create|save|add|tạo|viết|lưu)\s+(?:to\s+|the\s+file\s+|file\s+)?[`"']?([^\s`"'\n,]+\.[a-z]{1,5})[`"']?/i);
  if (writeMatch && /```[\s\S]+```/.test(norm)) {
    // Has a code block + mentions writing to a file
    const filePath = writeMatch[1];
    const codeMatch = norm.match(/```(?:\w+)?\n([\s\S]*?)```/);
    if (codeMatch) {
      const code = codeMatch[1].trim();
      const patches = `FILE:${filePath}\nSEARCH\n\nREPLACE\n${code}\nEND`;
      return { type: "write_patch", input: { patches } };
    }
  }
  
  // Detect read_file intent
  // Patterns: "let me read...", "I'll check...", "looking at file...", "đọc file..."
  const readMatch = norm.match(/(?:read|check|look at|open|view|xem|đọc|kiểm tra)\s+(?:the\s+)?(?:file\s+)?[`"']?([^\s`"'\n,]+\.[a-z]{1,5})[`"']?/i);
  if (readMatch && !lower.includes("write") && !lower.includes("create")) {
    return { type: "read_file", input: { path: readMatch[1] } };
  }
  
  // Detect list_files intent  
  // Patterns: "list directory", "xem thư mục", "see what's in..."
  const listMatch = norm.match(/(?:list|show|see what'?s? in|xem|liệt kê)\s+(?:the\s+)?(?:directory|folder|thư mục)?\s*[`"']?([^\s`"'\n]+)[`"']?/i);
  if (listMatch) {
    return { type: "list_files", input: { dir: listMatch[1] || "." } };
  }
  
  // Detect search_code intent
  // Patterns: "search for...", "find...", "grep...", "tìm kiếm..."
  const searchMatch = norm.match(/(?:search|find|grep|look for|tìm|tìm kiếm)\s+(?:for\s+)?[`"']?([^`"'\n]+)[`"']?/i);
  if (searchMatch && searchMatch[1].length > 2 && searchMatch[1].length < 100) {
    return { type: "search_code", input: { query: searchMatch[1].trim() } };
  }
  
  // Detect run_command intent
  // Patterns: "run...", "execute...", "chạy...", commands in backticks
  const cmdMatch = norm.match(/(?:run|execute|chạy|thực thi)\s+[`"']?([^`"'\n]+)[`"']?/i) ||
                   norm.match(/```(?:bash|sh|shell)?\s*\n?([^\n]+)\n?```/i);
  if (cmdMatch && !cmdMatch[1].includes("{") && cmdMatch[1].length < 200) {
    const isBg = /(?:background|chạy ngầm|ẩn)/i.test(norm);
    return { type: "run_command", input: { cmd: cmdMatch[1].trim(), ...(isBg ? { background: true } : {}) } };
  }
  
  // Detect codebase_map intent
  if (/(?:overview|structure|map|cấu trúc|tổng quan)/i.test(lower) && /(?:codebase|project|repo|dự án)/i.test(lower)) {
    return { type: "codebase_map", input: { max_depth: 3 } };
  }
  
  return null;
}

/**
 * Check if response looks like a complete answer that doesn't need tools.
 */
function looksLikeCompleteAnswer(text: string): boolean {
  const lower = text.toLowerCase();
  
  // Direct answers start with these patterns
  const answerPatterns = [
    /^(yes|no|ok|sure|certainly|of course|definitely)/i,
    /^(the|this|that|it|i|we|you|here)/i,
    /^(đây|đó|vâng|không|được|có|là|tôi)/i,
    /^[\d\.\-\*]/,  // Lists
  ];
  
  if (answerPatterns.some(p => p.test(text.trim().slice(0, 30)))) {
    // But not if it mentions needing to do something
    if (/(let me|i('ll| will| need to| should)|cần|phải|để)/i.test(lower)) {
      return false;
    }
    return true;
  }
  
  // Completion indicators
  const completionIndicators = [
    "done", "complete", "finished", "success", 
    "hoàn thành", "xong", "thành công", "đã",
    "here's", "here is", "đây là"
  ];
  if (completionIndicators.some(ind => lower.includes(ind))) {
    return true;
  }
  
  return false;
}

/**
 * Extracts ALL complete `ACTION: {...}` blocks from a text using brace-depth
 * tracking. Used both by `parseAgentResponse` (post-stream) and by the runner
 * for streaming early-action detection.
 */
function pushActionWhenComplete(
  actions: Array<{ type: string; input: Record<string, unknown> }>,
  act: { type: string; input: Record<string, unknown> },
): void {
  if (act.type === "write_patch") {
    const patches = act.input.patches;
    if (typeof patches !== "string" || !writePatchPayloadLooksComplete(patches)) return;
  }
  actions.push(act);
}

/**
 * While the model streams a large tool JSON, surface write_patch/create_file in the UI trace.
 */
export function detectStreamingToolPayload(buf: string): { tool: string } | null {
  const normalized = normalizeAgentText(buf);
  const trimmed = normalized.trimStart();
  if (trimmed.startsWith("{")) {
    const head = trimmed.slice(0, 16_000);
    if (/"patches"\s*:/.test(head)) return { tool: "write_patch" };
    const m = /"type"\s*:\s*"([^"]+)"/.exec(head);
    if (m && (m[1] === "write_patch" || m[1] === "create_file")) return { tool: m[1] };
  }
  const markerMatch = /(?:^|\n)ACTION:\s*/i.exec(normalized);
  if (!markerMatch) return null;
  let after = normalized.slice(markerMatch.index + markerMatch[0].length).trimStart();
  if (/^```(?:json)?\s*\n?/i.test(after)) {
    after = after.replace(/^```(?:json)?\s*\n?/i, "");
  }
  const jsonStart = after.indexOf("{");
  if (jsonStart === -1) return null;
  const head = after.slice(jsonStart, jsonStart + 16_000);
  const m = /"type"\s*:\s*"([^"]+)"/.exec(head);
  if (!m) return null;
  if (m[1] === "write_patch" || m[1] === "create_file") return { tool: m[1] };
  return null;
}

export function extractAllActions(
  text: string,
): Array<{ type: string; input: Record<string, unknown> }> {
  const actions: Array<{ type: string; input: Record<string, unknown> }> = [];
  const normalized = normalizeAgentText(text);
  const leadingParsed = parseJsonObjectByBraceDepth(normalized.trimStart());
  if (leadingParsed) {
    const act = actionFromJsonRecord(leadingParsed.json);
    if (act) pushActionWhenComplete(actions, act);
  }
  const markerRe = /(?:^|\n)ACTION:\s*/gi;
  let m: RegExpExecArray | null;
  while ((m = markerRe.exec(normalized)) !== null) {
    const afterMarker = normalized.slice(m.index + m[0].length).trimStart();
    // Strip optional markdown fence
    const stripped = /^```(?:json)?\s*\n?/.test(afterMarker)
      ? afterMarker.replace(/^```(?:json)?\s*\n?/, "")
      : afterMarker;
    const jsonStart = stripped.indexOf("{");
    if (jsonStart === -1) continue;
    const frag = stripped.slice(jsonStart);
    // While streaming: wait for </html> (not write_patch END) before salvaging broken JSON.
    const salvagedEarly = salvageCreateFileFromFragment(frag, { requireClosingHtml: true });
    if (salvagedEarly) {
      pushActionWhenComplete(actions, salvagedEarly);
      continue;
    }
    let depth = 0;
    let inStr = false;
    let esc = false;
    let parsedThis = false;
    for (let i = 0; i < frag.length; i++) {
      const c = frag[i];
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
        if (depth === 0) {
          const parsed = actionFromActionFragment(frag.slice(0, i + 1));
          if (parsed) {
            pushActionWhenComplete(actions, parsed);
            parsedThis = true;
          }
          break;
        }
      }
    }
    if (!parsedThis) {
      const salvaged = salvageCreateFileFromFragment(frag);
      if (salvaged) pushActionWhenComplete(actions, salvaged);
    }
  }
  const seen = new Set<string>();
  const deduped: Array<{ type: string; input: Record<string, unknown> }> = [];
  for (const act of actions) {
    const key = actionScheduleKey(act.type, act.input);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(act);
  }
  for (const d of extractDsmlToolCalls(normalized)) {
    const key = actionScheduleKey(d.type, d.input);
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(d);
    }
  }
  return deduped;
}

export function parseAgentResponse(raw: string): AgentStep {
  const text = normalizeAgentText(raw).trim();
  const thought = extractBlock(text, "THOUGHT") ?? "";

  // 1. ACTION before FINAL — models often emit both; FINAL-first dropped tools on disk.
  const allActions = extractAllActions(text);
  if (allActions.length > 1) {
    return { kind: "multi_action", thought, actions: allActions };
  }
  if (allActions.length === 1) {
    return { kind: "action", thought, type: allActions[0].type, input: allActions[0].input };
  }

  const final = extractBlock(text, "FINAL");
  if (final !== null) {
    return { kind: "final", thought, result: final };
  }

  // 2. JSON in ```json``` blocks or anywhere in the response (fallback for non-ReAct format)
  for (const seg of fencedJsonSegments(text)) {
    const json = tryParseJson(seg);
    if (json) {
      const act = actionFromJsonRecord(json);
      if (act) return { kind: "action", thought, type: act.type, input: act.input };
    }
  }
  const leadingOnly = parseJsonObjectByBraceDepth(text.trimStart());
  if (leadingOnly) {
    const act = actionFromJsonRecord(leadingOnly.json);
    if (act) return { kind: "action", thought, type: act.type, input: act.input };
  }

  // 4. Detect tool intent from natural language
  const detectedTool = detectToolIntent(text);
  if (detectedTool) {
    return { kind: "action", thought: text, type: detectedTool.type, input: detectedTool.input };
  }

  // 5. If it looks like a complete answer, treat as FINAL
  if (looksLikeCompleteAnswer(text)) {
    // Check it's not trying to do something
    const lower = text.toLowerCase();
    const wantsAction = /(let me|i('ll| will| need to| should| want to)|first|next|now|cần|phải|để|trước|tiếp)/i.test(lower) &&
                        /(read|write|check|create|run|search|list|đọc|viết|kiểm tra|tạo|chạy|tìm)/i.test(lower);
    
    if (!wantsAction) {
      return { kind: "final", thought: "", result: text };
    }
  }

  return { kind: "error", raw, error: "Could not parse response - no clear action or answer found" };
}
