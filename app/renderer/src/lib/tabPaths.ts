/** Normalize workspace-relative paths for tab ↔ delete matching. */
export function normalizeRelPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "");
}

export interface TabLike {
  path: string;
  kind?: "file" | "diff" | "browser";
  displayPath?: string;
}

/** True when a deleted path removes this tab (file, or diff for that file, or children under a deleted dir). */
export function tabAffectedByDelete(tab: TabLike, deletedPaths: string[]): boolean {
  if (tab.kind === "browser") return false;
  const rel =
    tab.kind === "diff"
      ? (tab.displayPath ?? tab.path.replace(/^diff:[^:]+:/, ""))
      : tab.path;
  const t = normalizeRelPath(rel);
  if (!t || t.startsWith("diff:")) return false;
  for (const raw of deletedPaths) {
    const d = normalizeRelPath(raw);
    if (!d) continue;
    if (t === d || t.startsWith(`${d}/`)) return true;
  }
  return false;
}
