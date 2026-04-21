import { Router } from "express";
import { BA_DIFF_CREATED_FROM_ABSENT } from "../tools/patch.js";
import { deleteEntry, readFile, writeFile } from "../tools/file.js";

export const diffRouter = Router();

interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  body: string[];
}

function parseDiff(diff: string): { path: string; hunks: Hunk[] } | null {
  const headerMatch = /^---\s+a\/(.+)$/m.exec(diff);
  if (!headerMatch) return null;
  const path = headerMatch[1];

  const lines = diff.split("\n");
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;

  for (const ln of lines) {
    const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(ln);
    if (hm) {
      if (cur) hunks.push(cur);
      cur = {
        oldStart: parseInt(hm[1], 10),
        oldLines: hm[2] ? parseInt(hm[2], 10) : 1,
        newStart: parseInt(hm[3], 10),
        newLines: hm[4] ? parseInt(hm[4], 10) : 1,
        body: [],
      };
      continue;
    }
    if (!cur) continue;
    if (ln.startsWith("--- ") || ln.startsWith("+++ ") || ln.startsWith("diff ")) continue;
    cur.body.push(ln);
  }
  if (cur) hunks.push(cur);
  return { path, hunks };
}

/** Pull the "before" and "after" line arrays from a hunk body. */
function hunkSlices(body: string[]): { before: string[]; after: string[] } {
  const before: string[] = [];
  const after: string[] = [];
  for (const ln of body) {
    if (ln.length === 0) continue;
    if (ln.startsWith("\\")) continue; // "\ No newline at end of file"
    const marker = ln[0];
    const text = ln.slice(1);
    if (marker === " ") { before.push(text); after.push(text); }
    else if (marker === "-") before.push(text);
    else if (marker === "+") after.push(text);
  }
  return { before, after };
}

/**
 * True when the unified diff only adds lines (no `-` / context rows inside hunks),
 * i.e. `makeUnifiedDiff` from an empty "before". Used to delete the file on full
 * revert for older agent diffs that lack `BA_DIFF_CREATED_FROM_ABSENT`.
 */
function isPureAdditionFromEmptyFile(diff: string): boolean {
  const lines = diff.split("\n");
  let inHunk = false;
  let sawPlus = false;
  for (const ln of lines) {
    if (ln.startsWith("@@ ")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (ln.startsWith("\\")) continue;
    if (ln.length === 0) continue;
    const c = ln[0];
    if (c === "+") {
      sawPlus = true;
      continue;
    }
    if (c === " " || c === "-") return false;
    return false;
  }
  return sawPlus;
}

/** After a successful revert that yields empty contents, remove the path if this was a create-file change. */
function shouldDeleteFileWhenRevertedToEmpty(diff: string): boolean {
  if (diff.includes(BA_DIFF_CREATED_FROM_ABSENT)) return true;
  return isPureAdditionFromEmptyFile(diff);
}

/**
 * Revert a single hunk against the file's current contents. Tries
 * line-number-strict replacement first, then falls back to substring
 * substitution if the file has drifted (e.g. user-edited around the hunk).
 */
function revertHunkInPlace(current: string, hunk: Hunk): { ok: boolean; mode: string; next?: string } {
  const { before, after } = hunkSlices(hunk.body);
  const afterBlock = after.join("\n");
  const beforeBlock = before.join("\n");

  // Strict mode: splice the after-lines out of the file at the hunk's
  // 1-based newStart position and replace with the original before-lines.
  const fileLines = current.split("\n");
  const start = Math.max(0, hunk.newStart - 1);
  const candidate = fileLines.slice(start, start + hunk.newLines).join("\n");
  if (candidate === afterBlock) {
    const next = [
      ...fileLines.slice(0, start),
      ...before,
      ...fileLines.slice(start + hunk.newLines),
    ].join("\n");
    return { ok: true, mode: "strict", next };
  }

  // Fallback: substring substitution. Only safe when afterBlock is unique.
  if (afterBlock && current.includes(afterBlock)) {
    const occurrences = current.split(afterBlock).length - 1;
    if (occurrences === 1) {
      return { ok: true, mode: "substring", next: current.replace(afterBlock, beforeBlock) };
    }
  }

  return { ok: false, mode: "miss" };
}

/**
 * Revert every hunk in a diff. Hunks are applied in REVERSE order so the
 * line-number splice for earlier hunks isn't shifted by later ones.
 */
diffRouter.post("/diff/revert", async (req, res) => {
  try {
    const diff = String(req.body?.diff || "");
    if (!diff) return res.status(400).json({ error: "diff required" });
    const parsed = parseDiff(diff);
    if (!parsed) return res.status(400).json({ error: "invalid diff (no --- a/ header)" });
    if (parsed.hunks.length === 0) return res.status(400).json({ error: "invalid diff (no @@ marker)" });

    let current: string;
    try {
      current = await readFile(parsed.path);
    } catch {
      // File already deleted (e.g. user undid twice, or removed manually). For
      // "created from empty" diffs the reverted state is "no file" — treat as OK
      // so the UI can drop the row instead of looping on 404.
      if (shouldDeleteFileWhenRevertedToEmpty(diff)) {
        res.json({
          ok: true,
          mode: "noop",
          path: parsed.path,
          deleted: true,
          alreadyAbsent: true,
        });
        return;
      }
      return res.status(404).json({ error: `file not found: ${parsed.path}` });
    }

    const modes: string[] = [];
    for (const h of [...parsed.hunks].reverse()) {
      const r = revertHunkInPlace(current, h);
      if (!r.ok) {
        return res.status(409).json({
          error: "current file does not match diff; revert skipped",
          path: parsed.path,
        });
      }
      current = r.next!;
      modes.push(r.mode);
    }

    if (current === "" && shouldDeleteFileWhenRevertedToEmpty(diff)) {
      await deleteEntry(parsed.path);
      res.json({ ok: true, mode: modes.join("+"), path: parsed.path, deleted: true });
    } else {
      await writeFile(parsed.path, current);
      res.json({ ok: true, mode: modes.join("+"), path: parsed.path });
    }
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/**
 * Revert just one hunk of a diff (per-hunk Undo). The frontend supplies the
 * full diff plus a 0-based `hunkIndex` matching backend order.
 */
diffRouter.post("/diff/revert-hunk", async (req, res) => {
  try {
    const diff = String(req.body?.diff || "");
    const hunkIndex = Number(req.body?.hunkIndex);
    if (!diff) return res.status(400).json({ error: "diff required" });
    if (!Number.isInteger(hunkIndex) || hunkIndex < 0) {
      return res.status(400).json({ error: "hunkIndex must be a non-negative integer" });
    }
    const parsed = parseDiff(diff);
    if (!parsed) return res.status(400).json({ error: "invalid diff (no --- a/ header)" });
    if (hunkIndex >= parsed.hunks.length) {
      return res.status(400).json({ error: `hunkIndex out of range (have ${parsed.hunks.length})` });
    }

    let current: string;
    try {
      current = await readFile(parsed.path);
    } catch {
      if (shouldDeleteFileWhenRevertedToEmpty(diff)) {
        res.json({
          ok: true,
          mode: "noop",
          path: parsed.path,
          hunkIndex,
          deleted: true,
          alreadyAbsent: true,
        });
        return;
      }
      return res.status(404).json({ error: `file not found: ${parsed.path}` });
    }

    const r = revertHunkInPlace(current, parsed.hunks[hunkIndex]);
    if (!r.ok) {
      return res.status(409).json({
        error: "current file does not match this hunk; revert skipped",
        path: parsed.path,
        hunkIndex,
      });
    }
    const nextContent = r.next!;
    if (nextContent === "" && shouldDeleteFileWhenRevertedToEmpty(diff)) {
      await deleteEntry(parsed.path);
      res.json({ ok: true, mode: r.mode, path: parsed.path, hunkIndex, deleted: true });
    } else {
      await writeFile(parsed.path, nextContent);
      res.json({ ok: true, mode: r.mode, path: parsed.path, hunkIndex });
    }
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});
