// Recently-opened files, per workspace, persisted in localStorage.
// Used by the editor welcome screen to offer one-click reopen of the
// last few files the user touched in the current workspace.

const KEY_PREFIX = "pig-agents.recent-files.v1.";
const MAX_ENTRIES = 12;

export interface RecentFile {
  path: string;
  /** Epoch ms of the most recent open. */
  ts: number;
}

function keyFor(workspace: string): string {
  return KEY_PREFIX + workspace;
}

function safeParse(raw: string | null): RecentFile[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter(
      (x): x is RecentFile =>
        x && typeof x === "object" && typeof x.path === "string" && typeof x.ts === "number",
    );
  } catch {
    return [];
  }
}

export function listRecents(workspace: string): RecentFile[] {
  if (!workspace || typeof localStorage === "undefined") return [];
  const list = safeParse(localStorage.getItem(keyFor(workspace)));
  return list.sort((a, b) => b.ts - a.ts);
}

export function pushRecent(workspace: string, path: string): void {
  if (!workspace || !path || typeof localStorage === "undefined") return;
  const k = keyFor(workspace);
  const cur = safeParse(localStorage.getItem(k)).filter((x) => x.path !== path);
  cur.unshift({ path, ts: Date.now() });
  if (cur.length > MAX_ENTRIES) cur.length = MAX_ENTRIES;
  try {
    localStorage.setItem(k, JSON.stringify(cur));
  } catch {
    // Quota or disabled storage — silently ignore; recents are a nicety.
  }
}

export function removeRecent(workspace: string, path: string): void {
  if (!workspace || typeof localStorage === "undefined") return;
  const k = keyFor(workspace);
  const next = safeParse(localStorage.getItem(k)).filter((x) => x.path !== path);
  try {
    localStorage.setItem(k, JSON.stringify(next));
  } catch {
    /* noop */
  }
}

export function clearRecents(workspace: string): void {
  if (!workspace || typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(keyFor(workspace));
  } catch {
    /* noop */
  }
}
