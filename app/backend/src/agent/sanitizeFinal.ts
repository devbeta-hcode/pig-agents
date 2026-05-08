/**
 * Strip ReAct / rubric junk that models paste into FINAL or Ask-mode replies.
 * The user bubble must not show planning THOUGHT or "(lang) describing that I…" meta.
 */
export function sanitizeAssistantFinalText(raw: string): string {
  let s = raw.replace(/\r\n/g, "\n").trim();
  if (!s) return s;

  // Drop leaked THOUGHT blocks (same line or following lines)
  const lineThought = s.search(/\n\s*THOUGHT\s*:/i);
  if (lineThought >= 0) s = s.slice(0, lineThought).trim();

  const inlineThought = s.search(/\sTHOUGHT\s*:/i);
  if (inlineThought >= 0 && !/^\s*THOUGHT\s*:/im.test(s)) {
    s = s.slice(0, inlineThought).trim();
  }

  if (/^\s*THOUGHT\s*:/im.test(s)) {
    s = s.replace(/^\s*THOUGHT\s*:\s*/i, "").trim();
    const again = s.search(/\n\s*THOUGHT\s*:/i);
    if (again >= 0) s = s.slice(0, again).trim();
  }

  // System-shaped meta many models leak before the real answer
  s = s
    .replace(/^\s*\([^)]{0,120}\)\s*(?:describing|explaining|summarizing)\s+that\s+[^\n]+(?:\n|$)/i, "")
    .trim();

  return s.trim();
}

/** If sanitizer wiped useful content, keep original so the UI isn’t blank. */
export function sanitizeFinalOrKeep(raw: string, minLen = 12): string {
  const cleaned = sanitizeAssistantFinalText(raw);
  if (cleaned.length >= minLen) return cleaned;
  if (cleaned.length > 0 && raw.trim().length < minLen) return cleaned;
  return raw.trim();
}
