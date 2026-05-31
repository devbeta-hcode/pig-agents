/** Matches backend `BA_DIFF_CREATED_FROM_ABSENT` in unified diffs. */
const BA_CREATED = "# ba:created-from-absent";

/**
 * Path from `--- a/...` (same convention as backend `parseDiff`).
 */
export function diffPathFromUnified(diff: string): string | null {
  const m = /^---\s+a\/(.+)$/m.exec(diff.replace(/\r\n/g, "\n"));
  return m?.[1]?.trim() ?? null;
}

export function normalizeDiffPath(p: string): string {
  return p.replace(/^\.\//, "").replace(/\\/g, "/");
}

/**
 * Merge two sequential unified diffs for the **same file** (e.g. agent patched
 * twice). Revert/undo still sees one blob with all hunks.
 */
export function mergeUnifiedDiffs(older: string, newer: string): string {
  const po = diffPathFromUnified(older);
  const pn = diffPathFromUnified(newer);
  if (!po || !pn || normalizeDiffPath(po) !== normalizeDiffPath(pn)) return newer;

  const hunksOf = (d: string) => {
    const t = d.replace(/\r\n/g, "\n");
    const i = t.search(/^@@ /m);
    if (i < 0) return "";
    return t.slice(i).trimEnd();
  };

  const h1 = hunksOf(older);
  const h2 = hunksOf(newer);
  const ba = older.includes(BA_CREATED) ? `${BA_CREATED}\n` : "";
  if (!h1) return newer;
  if (!h2) return older;
  return `--- a/${po}\n+++ b/${po}\n${ba}${h1}\n${h2}\n`;
}
