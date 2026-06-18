/** Coerce XML/DSML parameter text to typed tool input values. */
export function parseParamInnerText(raw: string): string {
  const t = raw.trim();
  const cdata = /<!\[CDATA\[([\s\S]*?)\]\]>/i.exec(t);
  return (cdata ? cdata[1] : t).trim();
}

export function coerceToolParamValue(name: string, value: string): unknown {
  const v = parseParamInnerText(value);
  if (/^(start_line|end_line|top_k|max_depth|depth|maxChars|timeoutMs|offset)$/i.test(name)) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  if (v === "true") return true;
  if (v === "false") return false;
  return v;
}
