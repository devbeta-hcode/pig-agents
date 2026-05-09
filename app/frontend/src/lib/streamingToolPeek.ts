/**
 * Best-effort parsing of the in-flight ACTION JSON while the model is still
 * streaming tokens. Mirrors backend `detectStreamingToolPayload` / JSON shape.
 */

export type StreamingPeekTool = "write_patch" | "create_file";

/**
 * Some models stream `<thought>…</thought><action>{…}</action>` instead of
 * the canonical `THOUGHT:` / `ACTION:` markers. Normalize so peek + count
 * helpers see the expected shape.
 */
function normalizeXmlMarkers(buf: string): string {
  let out = buf;
  out = out.replace(/<\s*thought\s*>\s*/gi, "\nTHOUGHT: ");
  out = out.replace(/<\s*\/\s*thought\s*>\s*/gi, "\n");
  out = out.replace(/<\s*action\s*>\s*/gi, "\nACTION: ");
  out = out.replace(/<\s*\/\s*action\s*>\s*/gi, "\n");
  out = out.replace(/<\s*final\s*>\s*/gi, "\nFINAL: ");
  out = out.replace(/<\s*\/\s*final\s*>\s*/gi, "\n");
  return out;
}

/** Count ACTION: markers in streamed assistant buffer (each starts a logical tool call). */
export function actionMarkerCount(buf: string): number {
  const re = /(?:^|\r?\n)ACTION:\s*/gi;
  let c = 0;
  while (re.exec(normalizeXmlMarkers(buf)) !== null) c++;
  return c;
}

/**
 * Payload text after ACTION: for the nth marker (0-based), stopping before the following ACTION:
 * header (exclusive). Undefined when nth is missing (buffer not arrived yet).
 */
export function nthActionBlobAfterMarker(buf: string, n: number): string | undefined {
  const norm = normalizeXmlMarkers(buf);
  const re = /(?:^|\r?\n)ACTION:\s*/gi;
  let m: RegExpExecArray | null;
  const starts: number[] = [];
  while ((m = re.exec(norm)) !== null) starts.push(m.index + m[0].length);
  if (n < 0 || n >= starts.length) return undefined;
  const tail = norm.slice(starts[n]);
  const next = /\r?\nACTION:\s*/i.exec(tail);
  const cut = next ? next.index : tail.length;
  return tail.slice(0, cut);
}

export function peekStreamingToolPayloadNth(buf: string, nth: number): { tool: StreamingPeekTool } | null {
  const blob = nthActionBlobAfterMarker(buf, nth);
  if (!blob) return null;
  let after = blob.trimStart();
  if (/^```(?:json)?\s*\n?/i.test(after)) {
    after = after.replace(/^```(?:json)?\s*\n?/i, "");
  }
  const jsonStart = after.indexOf("{");
  if (jsonStart === -1) return null;
  const head = after.slice(jsonStart, jsonStart + 64_000);
  const m = /"type"\s*:\s*"([^"]+)"/.exec(head);
  if (!m) return null;
  if (m[1] === "write_patch" || m[1] === "create_file") return { tool: m[1] as StreamingPeekTool };
  return null;
}

export function peekStreamingToolPayload(buf: string): { tool: StreamingPeekTool } | null {
  return peekStreamingToolPayloadNth(buf, 0);
}

function unescapeJsonFragment(s: string): string {
  return s.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

/**
 * Read a possibly unterminated JSON string property from the prefix of ONE ACTION payload blob
 * (everything after ACTION: … up to next ACTION: header).
 */
function partialStringValueForJsonObjectPrefix(blob: string, key: string): string | null {
  let after = blob.trimStart();
  if (/^```(?:json)?\s*\n?/i.test(after)) after = after.replace(/^```(?:json)?\s*\n?/i, "");
  const jsonStart = after.indexOf("{");
  if (jsonStart === -1) return null;
  const rest = after.slice(jsonStart);
  const keyRe = new RegExp(`"${key}"\\s*:\\s*"`);
  const km = keyRe.exec(rest);
  if (!km) return null;
  let i = km.index + km[0].length;
  let out = "";
  while (i < rest.length) {
    const c = rest[i];
    if (c === "\\") {
      const n = rest[i + 1];
      if (n === undefined) break;
      if (n === "n") {
        out += "\n";
        i += 2;
        continue;
      }
      if (n === "t") {
        out += "\t";
        i += 2;
        continue;
      }
      if (n === "r") {
        out += "\r";
        i += 2;
        continue;
      }
      if (n === '"' || n === "\\" || n === "/") {
        out += n;
        i += 2;
        continue;
      }
      if (n === "u" && /^u[0-9a-fA-F]{4}/.test(rest.slice(i + 1, i + 6))) {
        out += String.fromCharCode(parseInt(rest.slice(i + 2, i + 6), 16));
        i += 6;
        continue;
      }
      out += n;
      i += 2;
      continue;
    }
    if (c === '"') return unescapeJsonFragment(out);
    out += c;
    i++;
  }
  return unescapeJsonFragment(out);
}

/** Live patches / patch / content for the nth ACTION block in buf. */
export function peekStreamingToolArgBodyNth(buf: string, nth: number): string | null {
  const meta = peekStreamingToolPayloadNth(buf, nth);
  if (!meta) return null;
  const blob = nthActionBlobAfterMarker(buf, nth);
  if (!blob) return null;
  if (meta.tool === "write_patch") {
    return (
      partialStringValueForJsonObjectPrefix(blob, "patches") ??
      partialStringValueForJsonObjectPrefix(blob, "patch")
    );
  }
  return partialStringValueForJsonObjectPrefix(blob, "content");
}

/** Live `patches` / `patch` or `content` inside the first streaming ACTION object. */
export function peekStreamingToolArgBody(buf: string): string | null {
  return peekStreamingToolArgBodyNth(buf, 0);
}

export function peekStreamingCreatePathNth(buf: string, nth: number): string | null {
  const meta = peekStreamingToolPayloadNth(buf, nth);
  if (!meta || meta.tool !== "create_file") return null;
  const blob = nthActionBlobAfterMarker(buf, nth);
  if (!blob) return null;
  return partialStringValueForJsonObjectPrefix(blob, "path");
}

export function peekStreamingCreatePath(buf: string): string | null {
  return peekStreamingCreatePathNth(buf, 0);
}

/**
 * SEARCH/REPLACE multi-file payloads repeat `FILE: path` markers. Split so each file
 * can render as its own accordion row instead of grouped chips (+N).
 */
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

  // Merge FILE sections that share the same filename into one slice so the
  // same file doesn't appear as N duplicate accordion rows.
  const fileNameOf = (c: string[]): string => {
    const m = c[0]?.match(/^\s*FILE:\s*(.+)/i);
    return m?.[1]?.trim() ?? "";
  };
  const merged = new Map<string, string[]>();
  const order: string[] = [];
  for (const chunk of chunks) {
    const name = fileNameOf(chunk);
    if (!name) continue;
    if (!merged.has(name)) { merged.set(name, []); order.push(name); }
    merged.get(name)!.push(...chunk);
  }
  return order.map((name) => merged.get(name)!.join("\n"));
}

/** Prefer live streamed patch text over partial JSON patches while observation is pending. */
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

/** One slice from the nth streamed ACTION write_patch blobs (multi-FILE payloads). */
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

/** Raw tail from ACTION: onward (for tool_payload_streaming when peek is empty). */
export function peekActionJsonTail(buf: string, maxChars = 8000): string {
  const norm = normalizeXmlMarkers(buf);
  const m = /(?:^|\n)ACTION:\s*/i.exec(norm);
  const slice = m ? norm.slice(m.index) : norm.slice(-maxChars);
  if (slice.length <= maxChars) return slice;
  return `${slice.slice(0, maxChars)}\n…`;
}
