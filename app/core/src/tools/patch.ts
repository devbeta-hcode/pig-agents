import { readFile, writeFile } from "./file.js";

export interface PatchBlock {
  path: string;
  search: string;
  replace: string;
}

export interface PatchResult {
  path: string;
  applied: boolean;
  diff: string;
  error?: string;
}

/** Short stable codes for OBSERVATION summaries so the model and UI can scan failures quickly. */
export type PatchApplyErrorCode = "WP_SEARCH_MISS" | "WP_SEARCH_AMBIGUOUS" | "WP_FILE_MISSING" | "WP_APPLY";

export function patchApplyErrorCode(error: string | undefined): PatchApplyErrorCode {
  if (!error) return "WP_APPLY";
  if (error === "SEARCH text not found") return "WP_SEARCH_MISS";
  if (/^SEARCH text matches \d+ times\b/.test(error)) return "WP_SEARCH_AMBIGUOUS";
  if (error.startsWith("File not found:")) return "WP_FILE_MISSING";
  return "WP_APPLY";
}

export type WritePatchFormatError = {
  code: WritePatchFormatCode;
  message: string;
};

export type WritePatchFormatCode =
  | "WP_EMPTY"
  | "WP_FMT_FILE_TRUNC"
  | "WP_FMT_AFTER_FILE"
  | "WP_FMT_DEFAULT_SEARCH"
  | "WP_FMT_NEED_FILE_OR_PATH";

/**
 * Structural validation before parsing/applying. Catches the common model mistake:
 * `FILE: path` then raw file body with no SEARCH/REPLACE markers.
 *
 * @returns `null` if shape is acceptable for `parsePatch`; otherwise code + message (summary uses `[code] message`).
 */
export function validateWritePatchPayload(raw: string, defaultPathTrimmed?: string): WritePatchFormatError | null {
  const text = raw.replace(/\r\n/g, "\n");
  const t = text.trim();
  if (!t) return { code: "WP_EMPTY", message: "write_patch patches string is empty." };

  if (/^FILE:/m.test(t)) {
    const parts = t.split(/(?=^FILE:)/m);
    for (const part of parts) {
      const seg = part.trim();
      if (!seg.startsWith("FILE:")) continue;
      const nl = seg.indexOf("\n");
      if (nl === -1) {
        return {
          code: "WP_FMT_FILE_TRUNC",
          message:
            'Each FILE: line must be followed by a newline, then a line exactly "SEARCH", then old text, a line "REPLACE", new text, optional "END".',
        };
      }
      const pathHint = seg.slice(0, nl).replace(/^FILE:[ \t]*/i, "").trim() || "(path)";
      const afterPath = seg.slice(nl + 1);
      if (!afterPath.startsWith("SEARCH\n")) {
        return {
          code: "WP_FMT_AFTER_FILE",
          message:
            `After FILE: ${pathHint} the next line must be exactly "SEARCH", then old text, then "REPLACE", then new text, then optional "END". ` +
            `Do not paste raw file content under FILE:. For a new file use SEARCH\\n\\nREPLACE\\n<full file>\\nEND.`,
        };
      }
    }
    return null;
  }

  if (defaultPathTrimmed) {
    if (!t.startsWith("SEARCH\n")) {
      return {
        code: "WP_FMT_DEFAULT_SEARCH",
        message:
          'When using input.path, the patches body must start with "SEARCH\\n", then old text, "REPLACE\\n", then new text. ' +
          "Or use multi-file format: FILE: rel/path then SEARCH/REPLACE blocks.",
      };
    }
    return null;
  }

  return {
    code: "WP_FMT_NEED_FILE_OR_PATH",
    message:
      "Include at least one FILE: <relative-path> block with SEARCH/REPLACE/END, " +
      'or pass path plus a body that starts with "SEARCH\\n".',
  };
}

/**
 * Parse a patch payload. Two accepted shapes:
 *
 * 1) Multi-file labeled blocks:
 *    FILE: path/to/file.ts
 *    SEARCH
 *    <old code>
 *    REPLACE
 *    <new code>
 *    END
 *
 * 2) A single-file payload provided alongside a path argument:
 *    SEARCH
 *    <old code>
 *    REPLACE
 *    <new code>
 */
export function parsePatch(raw: string, defaultPath?: string): PatchBlock[] {
  const text = raw.replace(/\r\n/g, "\n").trim();
  if (!text) return [];

  const blocks: PatchBlock[] = [];

  if (/^FILE:/m.test(text)) {
    // Non-greedy REPLACE that stops at \nEND, \nFILE:, or end-of-string.
    // Avoid multiline `$` because the lookahead would terminate early at any newline.
    const re = /FILE:[ \t]*(.+?)[ \t]*\nSEARCH\n([\s\S]*?)\nREPLACE\n([\s\S]*?)(?:\nEND\b|(?=\nFILE:)|$)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      blocks.push({ path: m[1].trim(), search: m[2], replace: m[3] });
    }
    return blocks;
  }

  const single = /SEARCH\n([\s\S]*?)\nREPLACE\n([\s\S]*?)$/s.exec(text);
  if (single && defaultPath) {
    // Strip an optional trailing `END` sentinel: write_patch single-file
    // form doesn't require it, but the model often appends one out of habit
    // from the multi-FILE shape and it would otherwise become a literal
    // line at the bottom of the file.
    const replaceBody = single[2].replace(/\n[ \t]*END[ \t]*\s*$/, "");
    blocks.push({ path: defaultPath, search: single[1], replace: replaceBody });
  }
  return blocks;
}

function normalizeEOL(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** After `+++ b/...` so `/diff/revert` can delete the file when undoing a create-file patch. */
export const BA_DIFF_CREATED_FROM_ABSENT = "# ba:created-from-absent";

type MakeUnifiedDiffOpts = number | { context?: number; markCreatedFromAbsent?: boolean };

function resolveUnifiedDiffOpts(opts: MakeUnifiedDiffOpts): { context: number; markCreatedFromAbsent: boolean } {
  if (typeof opts === "number") return { context: opts, markCreatedFromAbsent: false };
  return { context: opts.context ?? 3, markCreatedFromAbsent: !!opts.markCreatedFromAbsent };
}

/**
 * Build a real, per-hunk unified diff (with line numbers and a small context
 * window) from before/after text. Each meaningful change region becomes its
 * own `@@ -X,Y +A,B @@` hunk so the UI can offer per-hunk Keep / Undo.
 *
 * Empty result means "before === after" (no diff body, no header).
 *
 * Pass `{ markCreatedFromAbsent: true }` when the patch created a file that
 * did not exist (so revert can remove the path instead of leaving an empty file).
 */
export function makeUnifiedDiff(filePath: string, before: string, after: string, opts: MakeUnifiedDiffOpts = 3): string {
  const { context, markCreatedFromAbsent } = resolveUnifiedDiffOpts(opts);
  before = normalizeEOL(before);
  after = normalizeEOL(after);
  if (before === after) return "";

  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;

  // Standard LCS diff; tags are " " | "+" | "-".
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  type Op = { tag: " " | "+" | "-"; line: string; aIdx: number; bIdx: number };
  const ops: Op[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ tag: " ", line: a[i], aIdx: i, bIdx: j }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ tag: "-", line: a[i], aIdx: i, bIdx: j }); i++; }
    else { ops.push({ tag: "+", line: b[j], aIdx: i, bIdx: j }); j++; }
  }
  while (i < n) { ops.push({ tag: "-", line: a[i], aIdx: i, bIdx: j }); i++; }
  while (j < m) { ops.push({ tag: "+", line: b[j], aIdx: i, bIdx: j }); j++; }

  const changedIdx: number[] = [];
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].tag !== " ") changedIdx.push(k);
  }
  if (changedIdx.length === 0) return "";

  // Group changes that are within `2 * context` ops of each other into the
  // same hunk so neighbouring edits collapse into one continuous block.
  const groups: { startOp: number; endOp: number }[] = [];
  let curStart = changedIdx[0];
  let curEnd = changedIdx[0];
  for (let k = 1; k < changedIdx.length; k++) {
    const idx = changedIdx[k];
    if (idx - curEnd <= context * 2) {
      curEnd = idx;
    } else {
      groups.push({ startOp: curStart, endOp: curEnd });
      curStart = idx;
      curEnd = idx;
    }
  }
  groups.push({ startOp: curStart, endOp: curEnd });

  const hunks: string[] = [];
  for (const g of groups) {
    const start = Math.max(0, g.startOp - context);
    const end = Math.min(ops.length - 1, g.endOp + context);

    let aStart = -1, bStart = -1;
    let aLines = 0, bLines = 0;
    const body: string[] = [];
    for (let k = start; k <= end; k++) {
      const o = ops[k];
      body.push(`${o.tag}${o.line}`);
      if (o.tag === " " || o.tag === "-") {
        if (aStart === -1) aStart = o.aIdx;
        aLines++;
      }
      if (o.tag === " " || o.tag === "+") {
        if (bStart === -1) bStart = o.bIdx;
        bLines++;
      }
    }
    // Pure-insertion / pure-deletion hunks: anchor headers at the op's
    // current cursor in the unmatched stream so consumers can still locate
    // the change. Conventional unified-diff form for an empty side is
    // `-X,0` / `+X,0` where X is the line BEFORE the insertion in 1-based
    // numbering (0 means at the very top), which matches what `aIdx`/`bIdx`
    // already encode.
    const aHeaderStart = aStart === -1 ? ops[start].aIdx : aStart + 1;
    const bHeaderStart = bStart === -1 ? ops[start].bIdx : bStart + 1;

    hunks.push(
      `@@ -${aHeaderStart},${aLines} +${bHeaderStart},${bLines} @@\n${body.join("\n")}`,
    );
  }

  const meta = markCreatedFromAbsent ? `${BA_DIFF_CREATED_FROM_ABSENT}\n` : "";
  return `--- a/${filePath}\n+++ b/${filePath}\n${meta}${hunks.join("\n")}\n`;
}

export async function applyPatch(block: PatchBlock): Promise<PatchResult> {
  try {
    let before: string;
    try {
      before = await readFile(block.path);
    } catch {
      // create new file when SEARCH is empty
      if (block.search.trim().length === 0) {
        await writeFile(block.path, block.replace);
        return {
          path: block.path,
          applied: true,
          diff: makeUnifiedDiff(block.path, "", block.replace, { markCreatedFromAbsent: true }),
        };
      }
      throw new Error(`File not found: ${block.path}`);
    }

    if (block.search.length === 0) {
      // append/replace whole file when explicitly empty SEARCH
      await writeFile(block.path, block.replace);
      return { path: block.path, applied: true, diff: makeUnifiedDiff(block.path, before, block.replace) };
    }

    const beforeLF = before.replace(/\r\n/g, "\n");
    const searchLF = block.search.replace(/\r\n/g, "\n");
    const replaceLF = block.replace.replace(/\r\n/g, "\n");

    const idx = beforeLF.indexOf(searchLF);
    if (idx === -1) {
      return { path: block.path, applied: false, diff: "", error: "SEARCH text not found" };
    }
    const occurrences = beforeLF.split(searchLF).length - 1;
    if (occurrences > 1) {
      return { path: block.path, applied: false, diff: "", error: `SEARCH text matches ${occurrences} times; not unique` };
    }
    
    let after = beforeLF.replace(searchLF, replaceLF);
    if (before.includes("\r\n")) {
      after = after.replace(/\n/g, "\r\n");
    }

    await writeFile(block.path, after);
    return { path: block.path, applied: true, diff: makeUnifiedDiff(block.path, before, after) };
  } catch (err: unknown) {
    return { path: block.path, applied: false, diff: "", error: err instanceof Error ? err.message : String(err) };
  }
}

export async function applyPatches(raw: string, defaultPath?: string): Promise<PatchResult[]> {
  const blocks = parsePatch(raw, defaultPath);
  const results: PatchResult[] = [];
  for (const b of blocks) {
    results.push(await applyPatch(b));
  }
  return results;
}
