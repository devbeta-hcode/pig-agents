/**
 * Structured activity events for the chat UI status rail (replaces noisy info logs).
 */

export type ActivityPhase = "prepare" | "index" | "context" | "llm" | "tool" | "done";

export type ActivityAgentEvent = {
  type: "activity";
  phase: ActivityPhase;
  label: string;
  iteration?: number;
  tool?: string;
};

export function activityEvent(
  phase: ActivityPhase,
  label: string,
  opts?: { iteration?: number; tool?: string },
): ActivityAgentEvent {
  return {
    type: "activity",
    phase,
    label,
    iteration: opts?.iteration,
    tool: opts?.tool,
  };
}

/** Short human label for the status rail when a tool starts. */
export function toolActivityLabel(tool: string, input: Record<string, unknown>): string {
  const t = tool.toLowerCase();
  const path = String(input.path ?? input.file ?? "").replace(/\\/g, "/");
  const base = path ? path.split("/").pop() || path : "";
  switch (t) {
    case "read_file": {
      const start = input.start_line ?? input.startLine;
      const end = input.end_line ?? input.endLine;
      const range =
        start != null && end != null ? `:${start}–${end}` : start != null ? `:${start}` : "";
      return base ? `Reading ${base}${range}` : "Reading file";
    }
    case "write_patch":
      return base ? `Patching ${base}` : "Applying patch";
    case "create_file":
      return base ? `Creating ${base}` : "Creating file";
    case "delete_path":
    case "delete_file":
      return base ? `Deleting ${base}` : "Deleting path";
    case "search_code":
      return `Search "${String(input.query ?? "").slice(0, 48)}"`;
    case "semantic_search":
      return `Semantic "${String(input.query ?? "").slice(0, 40)}"`;
    case "find_symbol":
      return `Find symbol "${String(input.name ?? input.query ?? "").slice(0, 40)}"`;
    case "find_references":
      return `References "${String(input.name ?? input.symbol ?? "").slice(0, 40)}"`;
    case "run_command": {
      const cmd = String(input.cmd ?? input.command ?? "").trim();
      return cmd.length > 52 ? `Run ${cmd.slice(0, 49)}…` : cmd ? `Run ${cmd}` : "Run command";
    }
    case "list_files":
      return `List ${String(input.dir ?? ".")}`;
    case "glob":
      return `Glob ${String(input.pattern ?? input.glob ?? "*")}`;
    case "codebase_map":
      return "Codebase map";
    default:
      return t.replace(/_/g, " ");
  }
}
