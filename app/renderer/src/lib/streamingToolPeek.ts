/**
 * Best-effort parsing of in-flight `<tool>` XML while the model streams tokens.
 * Mirrors backend `detectStreamingToolPayload` / `xmlTools.ts`.
 */

export type StreamingPeekTool = "write_patch" | "create_file";

function normalizeStreamMarkers(buf: string): string {
  let out = buf.replace(/\r\n/g, "\n");
  out = out.replace(/<\s*thought\s*>\s*/gi, "\nTHOUGHT: ");
  out = out.replace(/<\s*\/\s*thought\s*>\s*/gi, "\n");
  out = out.replace(/<\s*final\s*>\s*/gi, "\nFINAL: ");
  out = out.replace(/<\s*\/\s*final\s*>\s*/gi, "\n");
  out = out.replace(/(<\/tool\s*>)\s*(THOUGHT|FINAL):/gi, "$1\n$2:");
  return out;
}

function parseParamInnerText(raw: string): string {
  const t = raw.trim();
  const cdata = /<!\[CDATA\[([\s\S]*?)\]\]>/i.exec(t);
  return (cdata ? cdata[1] : t).trim();
}

function partialXmlParamValue(toolBlock: string, key: string): string | null {
  const openRe = new RegExp(`<${key}\\s*>\\s*(?:<!\\[CDATA\\[)?`, "i");
  const om = openRe.exec(toolBlock);
  if (!om) return null;
  const rest = toolBlock.slice(om.index + om[0].length);
  if (om[0].includes("CDATA")) {
    const end = rest.indexOf("]]>");
    return end >= 0 ? rest.slice(0, end) : rest;
  }
  const closeRe = new RegExp(`</${key}\\s*>`, "i");
  const cm = closeRe.exec(rest);
  const slice = cm ? rest.slice(0, cm.index) : rest;
  return parseParamInnerText(slice);
}

/** Count `<tool name=…>` openings in streamed buffer. */
export function toolBlockCount(buf: string): number {
  const re = /<tool\s+name=["'][^"']+["']\s*(?:\/\s*>|>)/gi;
  let c = 0;
  const norm = normalizeStreamMarkers(buf);
  while (re.exec(norm) !== null) c++;
  return c;
}

/** @deprecated Use toolBlockCount */
export const actionMarkerCount = toolBlockCount;

export function nthToolBlockRaw(buf: string, n: number): string | undefined {
  const norm = normalizeStreamMarkers(buf);
  const starts: number[] = [];
  const re = /<tool\s+name=["'][^"']+["']\s*(?:\/\s*>|>)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(norm)) !== null) starts.push(m.index);
  if (n < 0 || n >= starts.length) return undefined;
  const from = starts[n];
  const to = n + 1 < starts.length ? starts[n + 1] : norm.length;
  return norm.slice(from, to);
}

/** @deprecated Use nthToolBlockRaw */
export const nthActionBlobAfterMarker = nthToolBlockRaw;

function peekToolName(block: string): string | null {
  const m = /<tool\s+name=["']([^"']+)["']/i.exec(block);
  return m ? m[1].trim() : null;
}

export function peekStreamingToolPayloadNth(buf: string, nth: number): { tool: StreamingPeekTool } | null {
  const blob = nthToolBlockRaw(buf, nth);
  if (!blob) return null;
  const name = peekToolName(blob);
  if (name === "write_patch" || name === "create_file") return { tool: name };
  return null;
}

export function peekStreamingToolPayload(buf: string): { tool: StreamingPeekTool } | null {
  return peekStreamingToolPayloadNth(buf, 0);
}

export function peekStreamingToolArgBodyNth(buf: string, nth: number): string | null {
  const meta = peekStreamingToolPayloadNth(buf, nth);
  if (!meta) return null;
  const blob = nthToolBlockRaw(buf, nth);
  if (!blob) return null;
  if (meta.tool === "write_patch") {
    return partialXmlParamValue(blob, "patches") ?? partialXmlParamValue(blob, "patch");
  }
  return partialXmlParamValue(blob, "content");
}

export function peekStreamingToolArgBody(buf: string): string | null {
  return peekStreamingToolArgBodyNth(buf, 0);
}

export function peekStreamingCreatePathNth(buf: string, nth: number): string | null {
  const meta = peekStreamingToolPayloadNth(buf, nth);
  if (!meta || meta.tool !== "create_file") return null;
  const blob = nthToolBlockRaw(buf, nth);
  if (!blob) return null;
  return partialXmlParamValue(blob, "path");
}

export function peekStreamingCreatePath(buf: string): string | null {
  return peekStreamingCreatePathNth(buf, 0);
}

export function splitWritePatchByFileSections(patchBlob: string): string[] {
  const normalized = patchBlob.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const chunks: string[][] = [];
  let cur: string[] | null = null;
  for (const line of lines) {
    if (/^\s*FILE:/i.test(line)) {
      if (cur && cur.length) chunks.push(cur);
      cur = [line];
    } else if (cur) cur.push(line);
  }
  if (cur?.length) chunks.push(cur);
  if (chunks.length === 0) return patchBlob.trim() ? [patchBlob] : [""];
  if (chunks.length === 1) return [chunks[0].join("\n")];

  const fileNameOf = (c: string[]): string => {
    const fm = c[0]?.match(/^\s*FILE:\s*(.+)/i);
    return fm?.[1]?.trim() ?? "";
  };
  const merged = new Map<string, string[]>();
  const order: string[] = [];
  for (const chunk of chunks) {
    const name = fileNameOf(chunk);
    if (!name) continue;
    if (!merged.has(name)) {
      merged.set(name, []);
      order.push(name);
    }
    merged.get(name)!.push(...chunk);
  }
  return order.map((name) => merged.get(name)!.join("\n"));
}

export function mergeWritePatchStreamBody(
  storedPatches: string,
  streamingPartial: string,
  hasObservation: boolean,
  streamingActionOrdinal = 0,
): string {
  if (hasObservation) return storedPatches;
  const peek = peekStreamingToolArgBodyNth(streamingPartial, streamingActionOrdinal) ?? "";
  if (peek.length > storedPatches.length) return peek;
  if (storedPatches.length > 0) return storedPatches;
  return peek;
}

export function peekWritePatchSectionNth(
  streamingPartial: string,
  actionOrdinal: number,
  sliceIndex: number,
): string | undefined {
  const peekFull = peekStreamingToolArgBodyNth(streamingPartial, actionOrdinal);
  if (peekFull == null || peekFull.trim() === "") return undefined;
  const fromPeek = splitWritePatchByFileSections(peekFull);
  if (fromPeek.length <= sliceIndex) return undefined;
  return fromPeek[sliceIndex];
}

export function peekWritePatchSection(streamingPartial: string, sliceIndex: number): string | undefined {
  return peekWritePatchSectionNth(streamingPartial, 0, sliceIndex);
}

/** Raw tail from first `<tool` onward (tool_payload_streaming fallback). */
export function peekActionXmlTail(buf: string, maxChars = 8000): string {
  const norm = normalizeStreamMarkers(buf);
  const m = /<tool\s/i.exec(norm);
  const slice = m ? norm.slice(m.index) : norm.slice(-maxChars);
  if (slice.length <= maxChars) return slice;
  return `${slice.slice(0, maxChars)}\n…`;
}

/** @deprecated Use peekActionXmlTail */
export const peekActionJsonTail = peekActionXmlTail;
