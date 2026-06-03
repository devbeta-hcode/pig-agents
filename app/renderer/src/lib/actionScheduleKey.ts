/** Mirror of core `actionScheduleKey` — dedupe action rows in chat timeline. */
export function actionScheduleKey(type: string, input: Record<string, unknown>): string {
  const t = type.toLowerCase();
  if (t === "create_file") {
    const path = String(input.path ?? input.file ?? "")
      .replace(/\\/g, "/")
      .trim();
    return `create_file:${path}`;
  }
  if (t === "write_patch") {
    const raw = String(input.patches ?? input.patch ?? "");
    const files = [...raw.matchAll(/^\s*FILE:\s*(.+?)\s*$/gim)]
      .map((m) => m[1].trim().replace(/\\/g, "/"))
      .filter(Boolean)
      .sort();
    if (files.length) return `write_patch:${files.join("|")}`;
    return `write_patch:${raw.length}:${raw.slice(0, 80)}`;
  }
  return `${t}:${JSON.stringify(input)}`;
}

function pathFromObservation(e: { summary?: string; diffs?: string[] }): string {
  const sum = String(e.summary ?? "");
  const m = sum.match(/(?:create_file|write|wrote|file)[^\n]*?([\w./\\-]+\.[a-z0-9]{1,8})/i);
  if (m?.[1]) return m[1].replace(/\\/g, "/");
  const d0 = e.diffs?.[0];
  if (typeof d0 === "string") {
    const dm = d0.match(/^(?:\+\+\+|---)\s+(.+)$/m) ?? d0.match(/^---\s+(.+)$/m);
    if (dm?.[1]) return dm[1].replace(/\\/g, "/").trim();
  }
  return "";
}

/** Collapse duplicate streaming create_file rows (same path, growing JSON). */
export function dedupeTraceTimelineEvents<T extends { type: string; iteration?: number; tool?: string; input?: Record<string, unknown>; summary?: string; diffs?: string[] }>(
  events: T[],
): T[] {
  const lastAction = new Map<string, number>();
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.type !== "action") continue;
    const iter = Number(e.iteration ?? 1);
    const key = `${iter}:${actionScheduleKey(String(e.tool ?? ""), (e.input ?? {}) as Record<string, unknown>)}`;
    lastAction.set(key, i);
  }
  const lastObs = new Map<string, number>();
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.type !== "observation") continue;
    const iter = Number(e.iteration ?? 1);
    const path = pathFromObservation(e);
    const key = path ? `${iter}:obs:${path}` : `${iter}:obs:${i}`;
    lastObs.set(key, i);
  }
  if (lastAction.size === 0 && lastObs.size === 0) return events;
  return events.filter((e, i) => {
    if (e.type === "action") {
      const iter = Number(e.iteration ?? 1);
      const key = `${iter}:${actionScheduleKey(String(e.tool ?? ""), (e.input ?? {}) as Record<string, unknown>)}`;
      return lastAction.get(key) === i;
    }
    if (e.type === "observation") {
      const iter = Number(e.iteration ?? 1);
      const path = pathFromObservation(e);
      const key = path ? `${iter}:obs:${path}` : `${iter}:obs:${i}`;
      return lastObs.get(key) === i;
    }
    return true;
  });
}
