/**
 * Stable dedupe keys for agent tool scheduling (streaming must not re-emit on every token).
 */

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
