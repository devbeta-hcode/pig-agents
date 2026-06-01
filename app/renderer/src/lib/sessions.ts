import type { AgentEvent } from "./api";
import type { DiffItem } from "../components/DiffViewer";

export type ChatMode = "ask" | "agent";

export interface ChatImage {
  id: string;
  dataUrl: string;
  name: string;
}

export interface ChatSelectElMeta {
  key: string;
  tagLabel: string;
  screenshotDataUrl?: string;
  path?: string;
  url?: string;
  attributes?: Record<string, string>;
  textContent?: string;
  rect?: { top: number; left: number; width: number; height: number };
  computedStyles?: Record<string, string>;
}

export interface ChatTurn {
  id: string;
  task: string;
  mode?: ChatMode;
  events: (AgentEvent & Record<string, unknown>)[];
  status: "idle" | "running" | "done" | "error" | "stopped";
  startedAt: number;
  endedAt?: number;
  images?: ChatImage[];
  /** Labels for `{{select el N}}` tokens shown as inline chips in the user bubble. */
  selectElMeta?: ChatSelectElMeta[];
}

export interface ChatSession {
  id: string;
  title: string;
  workspace: string;
  mode?: ChatMode;
  createdAt: number;
  updatedAt: number;
  turns: ChatTurn[];
  /** Pending agent diff review list — persisted with the session on the backend. */
  pendingDiffs?: DiffItem[];
}

export function newSession(workspace: string, mode: ChatMode = "agent"): ChatSession {
  const now = Date.now();
  return {
    id: `s_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    title: "New chat",
    workspace,
    mode,
    createdAt: now,
    updatedAt: now,
    turns: [],
    pendingDiffs: [],
  };
}

export function shortTitle(task: string): string {
  const t = task.trim().replace(/\s+/g, " ");
  return t.length > 40 ? t.slice(0, 38) + "…" : t || "New chat";
}

/**
 * Summarize prior turns so `/agent/run` receives chat memory. Each agent HTTP
 * request is stateless — without this, a short follow-up like "do it now" has
 * no context from earlier plans.
 */
export function formatPriorTurnsForAgentTask(turns: ChatTurn[], maxTotalChars = 14000): string {
  if (turns.length === 0) return "";
  const blocks: string[] = [];
  for (const turn of turns) {
    const u = turn.task.trim();
    const finalEv = [...turn.events].reverse().find((e) => e.type === "final");
    const errEv = [...turn.events].reverse().find((e) => e.type === "error");
    let a = "";
    if (finalEv && "result" in finalEv) {
      a = String((finalEv as { result?: string }).result ?? "").trim();
    } else if (errEv && "message" in errEv) {
      a = `[Error] ${String((errEv as { message?: string }).message ?? "")}`;
    } else {
      a = "(no assistant reply)";
    }
    
    const files = new Set<string>();
    for (const e of turn.events) {
      if (e.type === "action" && "tool" in e && typeof e.tool === "string" && e.input && typeof e.input === "object") {
        const inp = e.input as Record<string, unknown>;
        if (e.tool === "create_file" && typeof inp.path === "string") files.add(inp.path);
        if (e.tool === "write_patch") {
          if (typeof inp.path === "string") files.add(inp.path);
          if (typeof inp.patches === "string") {
            const m = /FILE:\s*([^\n]+)/g;
            let match;
            while ((match = m.exec(inp.patches)) !== null) files.add(match[1].trim());
          }
        }
      }
    }
    const modifiedPrefix = files.size > 0 ? `(Modified files: ${Array.from(files).join(", ")})\n` : "";
    blocks.push(`[USER]\n${u}\n\n[ASSISTANT]\n${modifiedPrefix}${a}`);
  }
  const header =
    "CONVERSATION SO FAR — the user's latest message is under “CURRENT TASK” at the end; treat that as the active request.\n\n";
  const body = blocks.join("\n\n---\n\n");
  if (header.length + body.length <= maxTotalChars) {
    return header + body;
  }
  let start = 0;
  while (
    start < blocks.length &&
    header.length + blocks.slice(start).join("\n\n---\n\n").length > maxTotalChars
  ) {
    start++;
  }
  const tail = blocks.slice(start).join("\n\n---\n\n");
  const omit = start > 0 ? `… (${start} earlier turn(s) omitted)\n\n` : "";
  return header + omit + tail;
}

/** Full task string sent to the backend (history + latest user message). */
export function composeAgentTaskWithHistory(priorTurns: ChatTurn[], currentUserMessage: string): string {
  const prefix = formatPriorTurnsForAgentTask(priorTurns);
  const cur = currentUserMessage.trim();
  if (!prefix) return cur;
  return `${prefix}\n\n---\n\nCURRENT TASK (what the user just sent):\n${cur}`;
}
