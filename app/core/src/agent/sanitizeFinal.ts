/**
 * Strip ReAct / rubric junk that models paste into FINAL or Ask-mode replies.
 */
export function sanitizeAssistantFinalText(raw: string): string {
  let s = raw.replace(/\r\n/g, "\n").trim();
  if (!s) return s;

  s = s.replace(/<\s*thought\s*>\s*/gi, "\nTHOUGHT: ");
  s = s.replace(/<\s*\/\s*thought\s*>/gi, "");
  s = s.replace(/<\s*final\s*>\s*/gi, "\nFINAL: ");
  s = s.replace(/<\s*\/\s*final\s*>/gi, "").trim();
  s = s.replace(/<tool[\s\S]*?<\/tool\s*>/gi, "").trim();
  s = s.replace(/<tool\s+[^>]+\/\s*>/gi, "").trim();

  const finalMatch = s.match(/(?:^|\n)\s*FINAL\s*:\s*([\s\S]*)/i);
  if (finalMatch) {
    return finalMatch[1]
      .replace(/\n\s*(?:THOUGHT|<\s*tool)\b[\s\S]*$/i, "")
      .trim();
  }

  const thoughtPos = s.search(/(?:^|\n)\s*THOUGHT\s*:/i);
  if (thoughtPos >= 0) {
    const before = s.slice(0, thoughtPos).trim();
    if (before) return before;
    return "";
  }

  const toolPos = s.search(/<tool\s/i);
  if (toolPos >= 0) {
    const before = s.slice(0, toolPos).trim();
    if (before) return before;
    return "";
  }

  const inlineThought = s.search(/\sTHOUGHT\s*:/i);
  if (inlineThought >= 0) s = s.slice(0, inlineThought).trim();

  s = s
    .replace(/^\s*\([^)]{0,120}\)\s*(?:describing|explaining|summarizing)\s+that\s+[^\n]+(?:\n|$)/i, "")
    .trim();

  return s;
}

export function sanitizeFinalOrKeep(raw: string, minLen = 12): string {
  const cleaned = sanitizeAssistantFinalText(raw);
  if (cleaned.length >= minLen) return cleaned;
  const hasMarkers = /(?:^|\n)\s*(?:THOUGHT|FINAL)\s*:/i.test(raw) || /<tool\s/i.test(raw);
  if (!hasMarkers) return raw.trim();
  const finalMatch = raw.replace(/\r\n/g, "\n").match(/(?:^|\n)\s*FINAL\s*:\s*([\s\S]*)/i);
  if (finalMatch) {
    const f = finalMatch[1].replace(/\n\s*(?:THOUGHT|<\s*tool)\b[\s\S]*$/i, "").trim();
    if (f.length >= 1) return f;
  }
  return cleaned;
}
