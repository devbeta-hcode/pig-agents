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
  if (t === "delete_path" || t === "delete_file") {
    const path = String(input.path ?? input.file ?? "")
      .replace(/\\/g, "/")
      .trim();
    return `delete_path:${path}`;
  }
  if (t === "write_patch") {
    const raw = String(input.patches ?? input.patch ?? "");
    const files = [...raw.matchAll(/^\s*FILE:\s*(.+?)\s*$/gim)]
      .map((m) => m[1].trim().replace(/\\/g, "/"))
      .filter(Boolean)
      .sort();
    if (files.length) return `write_patch:${files.join("|")}`;
    // Stable while JSON streams — avoids duplicate ACTION rows / double tool runs per token growth.
    return "write_patch:__pending__";
  }
  if (t === "browser_eval") {
    const js = String(input.js ?? "")
      .replace(/\s+/g, " ")
      .trim();
    return `browser_eval:${js}`;
  }
  if (t.startsWith("browser_")) {
    const norm: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) {
      norm[k] = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : v;
    }
    return `${t}:${JSON.stringify(norm)}`;
  }
  return `${t}:${JSON.stringify(input)}`;
}
