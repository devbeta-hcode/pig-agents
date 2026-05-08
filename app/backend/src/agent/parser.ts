export type AgentStep =
  | { kind: "action"; thought: string; type: string; input: Record<string, unknown> }
  | { kind: "multi_action"; thought: string; actions: Array<{ type: string; input: Record<string, unknown> }> }
  | { kind: "final"; thought: string; result: string }
  | { kind: "error"; raw: string; error: string };

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
    } else if (json.type === "list_files") {
      input = { dir: json.input };
    } else if (json.type === "search_code") {
      input = { query: json.input };
    } else if (json.type === "run_command") {
      input = { cmd: json.input };
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
  const lower = text.toLowerCase();
  
  // Detect write_patch intent first (most important after lazy-final nudge)
  // Patterns: SEARCH/REPLACE blocks, "write to file", "create file", code blocks with file paths
  const searchReplaceMatch = text.match(/FILE:\s*([^\n]+)\s*\nSEARCH\n/i);
  if (searchReplaceMatch) {
    // Extract the full patches content
    const patchStart = text.indexOf("FILE:");
    if (patchStart !== -1) {
      const patches = text.slice(patchStart).trim();
      return { type: "write_patch", input: { patches } };
    }
  }
  
  // Detect write intent from "writing to X", "create X file", "save to X"
  const writeMatch = text.match(/(?:write|create|save|add|tạo|viết|lưu)\s+(?:to\s+|the\s+file\s+|file\s+)?[`"']?([^\s`"'\n,]+\.[a-z]{1,5})[`"']?/i);
  if (writeMatch && /```[\s\S]+```/.test(text)) {
    // Has a code block + mentions writing to a file
    const filePath = writeMatch[1];
    const codeMatch = text.match(/```(?:\w+)?\n([\s\S]*?)```/);
    if (codeMatch) {
      const code = codeMatch[1].trim();
      const patches = `FILE:${filePath}\nSEARCH\n\nREPLACE\n${code}\nEND`;
      return { type: "write_patch", input: { patches } };
    }
  }
  
  // Detect read_file intent
  // Patterns: "let me read...", "I'll check...", "looking at file...", "đọc file..."
  const readMatch = text.match(/(?:read|check|look at|open|view|xem|đọc|kiểm tra)\s+(?:the\s+)?(?:file\s+)?[`"']?([^\s`"'\n,]+\.[a-z]{1,5})[`"']?/i);
  if (readMatch && !lower.includes("write") && !lower.includes("create")) {
    return { type: "read_file", input: { path: readMatch[1] } };
  }
  
  // Detect list_files intent  
  // Patterns: "list directory", "xem thư mục", "see what's in..."
  const listMatch = text.match(/(?:list|show|see what'?s? in|xem|liệt kê)\s+(?:the\s+)?(?:directory|folder|thư mục)?\s*[`"']?([^\s`"'\n]+)[`"']?/i);
  if (listMatch) {
    return { type: "list_files", input: { dir: listMatch[1] || "." } };
  }
  
  // Detect search_code intent
  // Patterns: "search for...", "find...", "grep...", "tìm kiếm..."
  const searchMatch = text.match(/(?:search|find|grep|look for|tìm|tìm kiếm)\s+(?:for\s+)?[`"']?([^`"'\n]+)[`"']?/i);
  if (searchMatch && searchMatch[1].length > 2 && searchMatch[1].length < 100) {
    return { type: "search_code", input: { query: searchMatch[1].trim() } };
  }
  
  // Detect run_command intent
  // Patterns: "run...", "execute...", "chạy...", commands in backticks
  const cmdMatch = text.match(/(?:run|execute|chạy|thực thi)\s+[`"']?([^`"'\n]+)[`"']?/i) ||
                   text.match(/```(?:bash|sh|shell)?\s*\n?([^\n]+)\n?```/i);
  if (cmdMatch && !cmdMatch[1].includes("{") && cmdMatch[1].length < 200) {
    return { type: "run_command", input: { cmd: cmdMatch[1].trim() } };
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
export function extractAllActions(
  text: string,
): Array<{ type: string; input: Record<string, unknown> }> {
  const actions: Array<{ type: string; input: Record<string, unknown> }> = [];
  const markerRe = /(?:^|\n)ACTION:\s*/gi;
  let m: RegExpExecArray | null;
  while ((m = markerRe.exec(text)) !== null) {
    const afterMarker = text.slice(m.index + m[0].length).trimStart();
    // Strip optional markdown fence
    const stripped = /^```(?:json)?\s*\n?/.test(afterMarker)
      ? afterMarker.replace(/^```(?:json)?\s*\n?/, "")
      : afterMarker;
    const jsonStart = stripped.indexOf("{");
    if (jsonStart === -1) continue;
    const frag = stripped.slice(jsonStart);
    let depth = 0, inStr = false, esc = false;
    for (let i = 0; i < frag.length; i++) {
      const c = frag[i];
      if (esc) { esc = false; continue; }
      if (c === "\\" && inStr) { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === "{") depth++;
      if (c === "}") {
        depth--;
        if (depth === 0) {
          const json = tryParseJson(frag.slice(0, i + 1));
          if (json && typeof json.type === "string") {
            const step = parsedJsonToAction(json, "", "");
            if (step.kind === "action") actions.push({ type: step.type, input: step.input });
          }
          break;
        }
      }
    }
  }
  return actions;
}

export function parseAgentResponse(raw: string): AgentStep {
  const text = raw.replace(/\r\n/g, "\n").trim();
  const thought = extractBlock(text, "THOUGHT") ?? "";

  // 1. First try strict FINAL tag
  const final = extractBlock(text, "FINAL");
  if (final !== null) {
    return { kind: "final", thought, result: final };
  }

  // 2. Extract all ACTION blocks — supports parallel multi-action in one response.
  const allActions = extractAllActions(text);
  if (allActions.length > 1) {
    return { kind: "multi_action", thought, actions: allActions };
  }
  if (allActions.length === 1) {
    return { kind: "action", thought, type: allActions[0].type, input: allActions[0].input };
  }

  // 3. JSON in ```json``` blocks or anywhere in the response (fallback for non-ReAct format)
  for (const seg of fencedJsonSegments(text)) {
    const json = tryParseJson(seg);
    if (json && typeof json.type === "string") {
      return parsedJsonToAction(json, thought, text);
    }
  }
  const anyJson = tryParseJson(text);
  if (anyJson && typeof anyJson.type === "string") {
    return parsedJsonToAction(anyJson, thought, text);
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
