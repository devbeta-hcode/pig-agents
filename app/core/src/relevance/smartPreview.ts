/**
 * Build compact, match-centric file previews for agent context (not just file head).
 */

/** Extra line markers when previewing for debug-oriented tasks. */
const DEBUG_LINE_MARKERS =
  /\b(throw new|catch\s*\(|console\.(error|warn)|debugger|TODO|FIXME|@ts-expect-error|eslint-disable)\b/i;

export function buildMatchCentricPreview(
  content: string,
  tokens: string[],
  maxChars = 700,
  opts?: { preferDebugLines?: boolean },
): string {
  const lines = content.split(/\r?\n/);
  const useful = tokens.filter((t) => t.length > 2);
  const hit = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    const ll = lines[i].toLowerCase();
    if (opts?.preferDebugLines && DEBUG_LINE_MARKERS.test(lines[i])) {
      for (let d = -1; d <= 2; d++) {
        const j = i + d;
        if (j >= 0 && j < lines.length) hit.add(j);
      }
    }
    for (const tok of useful) {
      if (ll.includes(tok)) {
        for (let d = -2; d <= 2; d++) {
          const j = i + d;
          if (j >= 0 && j < lines.length) hit.add(j);
        }
      }
    }
  }

  const format = (indices: number[]) => {
    const sorted = [...indices].sort((a, b) => a - b);
    const parts: string[] = [];
    let i = 0;
    while (i < sorted.length) {
      const start = sorted[i];
      let end = start;
      while (i + 1 < sorted.length && sorted[i + 1] <= end + 2) {
        i++;
        end = sorted[i];
      }
      for (let ln = start; ln <= end && ln < lines.length; ln++) {
        parts.push(`${ln + 1}|${lines[ln]}`);
      }
      i++;
    }
    return parts.join("\n");
  };

  let body: string;
  if (hit.size === 0) {
    const head = Math.min(35, lines.length);
    body = lines.slice(0, head).map((l, i) => `${i + 1}|${l}`).join("\n");
    if (lines.length > head) body += `\n…(${lines.length} lines total)`;
  } else {
    body = format([...hit]);
    if (body.length > maxChars) {
      body = body.slice(0, maxChars) + "\n…(preview truncated)";
    }
  }

  if (body.length <= maxChars) return body;
  return body.slice(0, maxChars) + "\n…(preview truncated)";
}
