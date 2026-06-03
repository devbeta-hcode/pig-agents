/** Split a combined `[tool]: …` observation blob for one action row. */
export function sliceObservationForAction(
  obs: { type: string; ok?: boolean; summary?: string; diffs?: string[]; actionKey?: string; tool?: string },
  tool?: string,
  input?: Record<string, unknown>,
): typeof obs {
  if (obs.type !== "observation") return obs;
  if (obs.actionKey || obs.tool) return obs;

  const summary = obs.summary ?? "";
  if (!/\[[\w_]+\]:/.test(summary)) return obs;

  const toolName = (tool || "").toLowerCase();
  if (!toolName) return obs;

  const sections = summary.split(/\n\n(?=\[[\w_]+\]:)/);
  const path = toolName === "read_file" ? String(input?.path ?? "").trim() : "";

  for (const sec of sections) {
    const head = sec.match(/^\[([\w_]+)\]:\s*/);
    if (!head || head[1].toLowerCase() !== toolName) continue;
    const body = sec.slice(head[0].length).trim();
    if (path && toolName === "read_file") {
      const norm = path.replace(/\\/g, "/");
      if (!body.startsWith(norm) && !body.startsWith(path)) continue;
    }
    const ok = okFromToolSection(toolName, body, obs.ok ?? false);
    return {
      ...obs,
      ok,
      summary: body,
      diffs: toolName === "write_patch" || toolName === "create_file" ? obs.diffs : undefined,
    };
  }

  return { ...obs, ok: false, summary: `(no [${toolName}] section in combined observation)` };
}

function okFromToolSection(tool: string, body: string, fallback: boolean): boolean {
  if (tool === "read_file") return !body.startsWith("read_file error");
  if (tool === "write_patch" || tool === "create_file") {
    return !/\bFAIL\b/.test(body) && !/\[WP_/.test(body);
  }
  return fallback && !/^error/i.test(body);
}

export function observationLooksCombined(summary: string): boolean {
  const tags = summary.match(/\[[\w_]+\]:/g);
  return (tags?.length ?? 0) > 1;
}
