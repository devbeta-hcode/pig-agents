import type { AgentEvent } from "./api";

export type ActivityPhase = "prepare" | "index" | "context" | "llm" | "tool" | "done";

export interface ActivitySnapshot {
  phase: ActivityPhase;
  label: string;
  iteration?: number;
  tool?: string;
}

export interface RunLogLine {
  level: "info" | "warn" | "error";
  message: string;
  ts?: number;
}

type Ev = AgentEvent & { ts?: number; phase?: string; label?: string; tool?: string; iteration?: number };

export function isRedundantRunLog(message: string): boolean {
  const msg = message.trim();
  if (/^(Ask|Agent) mode starting:/.test(msg)) return true;
  if (/^Selected \d+ relevant files\.?$/.test(msg)) return true;
  if (/^Created checkpoint \(/.test(msg)) return true;
  if (/^Preparing agent context for /.test(msg)) return true;
  if (/^Ranking relevant files/.test(msg)) return true;
  if (/^Context ready \(/.test(msg)) return true;
  if (/^Agent mode: ReAct/.test(msg)) return true;
  if (/^Project rules:/.test(msg)) return true;
  return false;
}

export function collectRunLogs(events: Ev[]): RunLogLine[] {
  const out: RunLogLine[] = [];
  for (const e of events) {
    if (e.type !== "log") continue;
    const level = (e.level === "warn" || e.level === "error" ? e.level : "info") as RunLogLine["level"];
    const message = String(e.message ?? "").trim();
    if (!message) continue;
    out.push({ level, message, ts: e.ts });
  }
  return out;
}

export function collectVerboseRunLogs(events: Ev[]): RunLogLine[] {
  return collectRunLogs(events).filter((l) => !isRedundantRunLog(l.message));
}

export function latestActivity(events: Ev[]): ActivitySnapshot | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type !== "activity") continue;
    const phase = e.phase as ActivityPhase;
    if (!phase || !e.label) continue;
    return {
      phase,
      label: String(e.label),
      iteration: typeof e.iteration === "number" ? e.iteration : undefined,
      tool: typeof e.tool === "string" ? e.tool : undefined,
    };
  }
  return null;
}

/** In-flight tool when action exists without observation for same iteration. */
export function deriveLiveActivity(
  events: Ev[],
  isStreaming: boolean,
): ActivitySnapshot | null {
  const fromActivity = latestActivity(events);
  if (fromActivity) return fromActivity;
  if (!isStreaming) return null;

  const actions: { iteration: number; tool: string; idx: number }[] = [];
  const observations = new Set<string>();
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const iter = Number(e.iteration ?? 1);
    if (e.type === "action" && e.tool) {
      actions.push({ iteration: iter, tool: String(e.tool), idx: i });
    }
    if (e.type === "observation") {
      observations.add(`${iter}`);
    }
  }
  const last = actions[actions.length - 1];
  if (!last) return { phase: "llm", label: "Thinking…" };
  const toolLabel = formatToolStatusLabel(last.tool);
  return {
    phase: "tool",
    label: toolLabel,
    iteration: last.iteration,
    tool: last.tool,
  };
}

function formatToolStatusLabel(tool: string): string {
  switch (tool.toLowerCase()) {
    case "read_file":
      return "Reading file…";
    case "write_patch":
      return "Applying patch…";
    case "create_file":
      return "Creating file…";
    case "search_code":
      return "Searching code…";
    case "semantic_search":
      return "Semantic search…";
    case "run_command":
      return "Running command…";
    case "list_files":
      return "Listing files…";
    default:
      return tool.replace(/_/g, " ");
  }
}

export function latestAlert(events: Ev[]): RunLogLine | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type !== "log") continue;
    const level = e.level === "error" ? "error" : e.level === "warn" ? "warn" : null;
    if (!level) continue;
    const message = String(e.message ?? "").trim();
    if (!message || message.startsWith("Parse error:")) continue;
    return { level, message, ts: e.ts };
  }
  return null;
}
