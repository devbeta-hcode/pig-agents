/**
 * Agent tool calls as XML tags — sole format for Pig Agents Desktop.
 *
 *   <tool name="read_file"><path>src/a.ts</path></tool>
 *   <tool name="write_patch"><patches><![CDATA[FILE:…]]></patches></tool>
 */
import { coerceToolParamValue, parseParamInnerText } from "./toolParams.js";

export interface ParsedXmlTool {
  type: string;
  input: Record<string, unknown>;
}

const COMPLETE_TOOL_RE =
  /<tool\s+name=["']([^"']+)["']\s*(?:\/\s*>|>([\s\S]*?)<\/tool\s*>)/gi;

const OPEN_TOOL_RE = /<tool\s+name=["']([^"']+)["']\s*(?:\/\s*>|>)/gi;

function parseToolBody(body: string): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  if (!body.trim()) return input;
  const paramRe = /<([a-zA-Z_][\w-]*)\s*(?:\/>|\s*>([\s\S]*?)<\/\1\s*>)/gi;
  let pm: RegExpExecArray | null;
  while ((pm = paramRe.exec(body)) !== null) {
    const key = pm[1].trim();
    const rawVal = pm[2] !== undefined ? pm[2] : "";
    input[key] = coerceToolParamValue(key, rawVal);
  }
  return input;
}

/** All fully closed `<tool …>…</tool>` (or self-closing) blocks. */
export function extractCompleteXmlTools(text: string): ParsedXmlTool[] {
  const actions: ParsedXmlTool[] = [];
  let m: RegExpExecArray | null;
  COMPLETE_TOOL_RE.lastIndex = 0;
  while ((m = COMPLETE_TOOL_RE.exec(text)) !== null) {
    const type = m[1].trim();
    if (!type) continue;
    const body = m[2] ?? "";
    actions.push({ type, input: parseToolBody(body) });
  }
  return actions;
}

/** Raw inner text of param `key` inside one tool block (complete or streaming). */
export function partialXmlParamValue(toolBlock: string, key: string): string | null {
  const openRe = new RegExp(`<${key}\\s*>\\s*(?:<!\\[CDATA\\[)?`, "i");
  const om = openRe.exec(toolBlock);
  if (!om) return null;
  let i = om.index + om[0].length;
  const rest = toolBlock.slice(i);
  if (om[0].includes("CDATA")) {
    const end = rest.indexOf("]]>");
    return end >= 0 ? rest.slice(0, end) : rest;
  }
  const closeRe = new RegExp(`</${key}\\s*>`, "i");
  const cm = closeRe.exec(rest);
  const slice = cm ? rest.slice(0, cm.index) : rest;
  return parseParamInnerText(slice);
}

/** Slice tool blocks by opening `<tool name=…>` (nth is 0-based). */
export function nthToolBlockRaw(text: string, n: number): string | undefined {
  const starts: number[] = [];
  let m: RegExpExecArray | null;
  OPEN_TOOL_RE.lastIndex = 0;
  while ((m = OPEN_TOOL_RE.exec(text)) !== null) {
    starts.push(m.index);
  }
  if (n < 0 || n >= starts.length) return undefined;
  const from = starts[n];
  const to = n + 1 < starts.length ? starts[n + 1] : text.length;
  return text.slice(from, to);
}

export function toolBlockCount(text: string): number {
  let c = 0;
  OPEN_TOOL_RE.lastIndex = 0;
  while (OPEN_TOOL_RE.exec(text) !== null) c++;
  return c;
}

/** True when the nth tool block has a closing `</tool>`. */
export function nthToolBlockComplete(text: string, n: number): boolean {
  const block = nthToolBlockRaw(text, n);
  if (!block) return false;
  if (/<tool\s+name=["'][^"']+["']\s*\/\s*>/i.test(block)) return true;
  return /<\/tool\s*>/i.test(block);
}

export function peekStreamingToolName(block: string): string | null {
  const m = /<tool\s+name=["']([^"']+)["']/i.exec(block);
  return m ? m[1].trim() : null;
}
