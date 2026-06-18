/**
 * Normalize THOUGHT / FINAL markers (plain text or legacy XML wrappers).
 * Tool calls use `<tool name="…">` — not converted here.
 */
export function normalizeAgentMarkers(text: string): string {
  let out = text.replace(/\r\n/g, "\n");
  out = out.replace(/<\s*thought\s*>\s*/gi, "\nTHOUGHT: ");
  out = out.replace(/<\s*\/\s*thought\s*>\s*/gi, "\n");
  out = out.replace(/<\s*final\s*>\s*/gi, "\nFINAL: ");
  out = out.replace(/<\s*\/\s*final\s*>\s*/gi, "\n");
  out = out.replace(/(<\/tool\s*>)\s*(THOUGHT|FINAL):/gi, "$1\n$2:");
  return out;
}

export function extractBlock(text: string, label: "THOUGHT" | "FINAL"): string | null {
  const re = new RegExp(
    `(?:^|\\n)${label}:[ \\t]*\\n?([\\s\\S]*?)(?=\\n(?:THOUGHT|FINAL):|<\\s*tool\\s|$)`,
    "i",
  );
  const m = re.exec(text);
  return m ? m[1].trim() : null;
}
