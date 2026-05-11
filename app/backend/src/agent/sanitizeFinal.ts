/**
 * Strip ReAct / rubric junk that models paste into FINAL or Ask-mode replies.
 * The user bubble must not show planning THOUGHT/ACTION markers.
 *
 * Handles the common patterns:
 *   1. "THOUGHT: ...\nFINAL: answer"  → extract just "answer"
 *   2. "THOUGHT: ...\nACTION: ..."    → drop everything (no FINAL)
 *   3. "FINAL: answer"                → extract just "answer"
 *   4. Plain text with no markers     → return as-is
 */
export function sanitizeAssistantFinalText(raw: string): string {
  let s = raw.replace(/\r\n/g, "\n").trim();
  if (!s) return s;

  // Normalize XML-style markers (some models emit <thought>…</thought>)
  s = s.replace(/<\s*thought\s*>\s*/gi, "\nTHOUGHT: ");
  s = s.replace(/<\s*\/\s*thought\s*>/gi, "");
  s = s.replace(/<\s*action\s*>\s*/gi, "\nACTION: ");
  s = s.replace(/<\s*\/\s*action\s*>/gi, "");
  s = s.replace(/<\s*final\s*>\s*/gi, "\nFINAL: ");
  s = s.replace(/<\s*\/\s*final\s*>/gi, "").trim();

  // If FINAL: marker is present, extract only that section — ignore everything before it.
  const finalMatch = s.match(/(?:^|\n)\s*FINAL\s*:\s*([\s\S]*)/i);
  if (finalMatch) {
    // Strip any trailing THOUGHT/ACTION that the model may have appended after FINAL.
    return finalMatch[1]
      .replace(/\n\s*(?:THOUGHT|ACTION)\s*:[\s\S]*$/i, "")
      .trim();
  }

  // No FINAL marker — drop everything from THOUGHT: onward (model didn't finish).
  const thoughtPos = s.search(/(?:^|\n)\s*THOUGHT\s*:/i);
  if (thoughtPos >= 0) {
    // Keep any text that appeared before the first THOUGHT: line.
    const before = s.slice(0, thoughtPos).trim();
    if (before) return before;
    // Whole response is THOUGHT-only — return empty so sanitizeFinalOrKeep falls back to raw.
    return "";
  }

  // Drop inline THOUGHT: that appears mid-sentence (model slipped).
  const inlineThought = s.search(/\sTHOUGHT\s*:/i);
  if (inlineThought >= 0) s = s.slice(0, inlineThought).trim();

  // System-shaped meta many models leak before the real answer.
  s = s
    .replace(/^\s*\([^)]{0,120}\)\s*(?:describing|explaining|summarizing)\s+that\s+[^\n]+(?:\n|$)/i, "")
    .trim();

  return s;
}

/** If sanitizer wiped useful content, keep original so the UI isn't blank.
 *  But never fall back to raw when raw itself contains ReAct markers —
 *  that would put THOUGHT/ACTION text back in the user bubble. */
export function sanitizeFinalOrKeep(raw: string, minLen = 12): string {
  const cleaned = sanitizeAssistantFinalText(raw);
  if (cleaned.length >= minLen) return cleaned;
  // Cleaned is short/empty — only fall back to raw if raw has NO ReAct markers.
  const hasMarkers = /(?:^|\n)\s*(?:THOUGHT|ACTION|FINAL)\s*:/i.test(raw);
  if (!hasMarkers) return raw.trim();
  // Raw has markers but sanitizer produced nothing useful.
  // Try extracting FINAL: directly before giving up.
  const finalMatch = raw.replace(/\r\n/g, "\n").match(/(?:^|\n)\s*FINAL\s*:\s*([\s\S]*)/i);
  if (finalMatch) {
    const f = finalMatch[1].replace(/\n\s*(?:THOUGHT|ACTION)\s*:[\s\S]*$/i, "").trim();
    if (f.length >= 1) return f;
  }
  // Last resort: return cleaned even if short, rather than exposing raw markers.
  return cleaned;
}
