/**
 * DeepSeek / some gateways emit tool calls as DSML markup in message content
 * instead of ReAct `ACTION: {...}` JSON. Parsed into normal actions in parser.ts.
 */

export interface ParsedDsmlAction {
  type: string;
  input: Record<string, unknown>;
}

function parseParameterValue(raw: string): string {
  const t = raw.trim();
  const cdata = /<!\[CDATA\[([\s\S]*?)\]\]>/i.exec(t);
  return (cdata ? cdata[1] : t).trim();
}

function coerceInputValue(name: string, value: string): unknown {
  if (/^(start_line|end_line|top_k|max_depth|depth|maxChars)$/i.test(name)) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

/** Extract all `<|DSML|invoke ...>` tool calls from assistant text. */
export function extractDsmlToolCalls(text: string): ParsedDsmlAction[] {
  if (!/<\|DSML\|/i.test(text) && !/<\|dsml\|/i.test(text)) return [];

  const actions: ParsedDsmlAction[] = [];
  const invokeRe = /<\|DSML\|invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/\|DSML\|invoke>/gi;
  let m: RegExpExecArray | null;
  while ((m = invokeRe.exec(text)) !== null) {
    const type = m[1].trim();
    const body = m[2];
    const input: Record<string, unknown> = {};
    const paramRe =
      /<\|DSML\|parameter\s+name="([^"]+)"\s*(?:\/>|>([\s\S]*?)<\/\|DSML\|parameter>)/gi;
    let pm: RegExpExecArray | null;
    while ((pm = paramRe.exec(body)) !== null) {
      const key = pm[1].trim();
      const rawVal = pm[2] !== undefined ? pm[2] : "";
      input[key] = coerceInputValue(key, parseParameterValue(rawVal));
    }
    if (type) actions.push({ type, input });
  }
  return actions;
}
