const BASE = "/api";

/** Sent on every API request so the backend can scope tools to this tab's folder. */
export const WORKSPACE_HEADER = "X-Build-Agents-Workspace";

const SESSION_WS_KEY = "build-agents.workspace.v1";

/** Absolute workspace path for this browser tab only (see `setSessionWorkspace`). */
export function getSessionWorkspace(): string {
  try {
    return sessionStorage.getItem(SESSION_WS_KEY) || "";
  } catch {
    return "";
  }
}

export function setSessionWorkspace(absPath: string): void {
  try {
    sessionStorage.setItem(SESSION_WS_KEY, absPath);
  } catch { /* private mode / quota */ }
}

function apiFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const ws = getSessionWorkspace();
  const headers = new Headers(init?.headers);
  if (ws) headers.set(WORKSPACE_HEADER, ws);
  return fetch(input, { ...init, headers });
}

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size?: number;
  mtimeMs?: number;
}

export interface BrowseResult {
  path: string;
  parent: string | null;
  entries: { name: string; path: string; isDir: boolean }[];
  crumbs: { label: string; path: string }[];
}

export interface AgentEvent {
  type:
    | "log"
    | "iter_start"
    | "token"
    | "thought"
    | "action"
    | "command_chunk"
    | "observation"
    | "final"
    | "error"
    | "aborted"
    | "done"
    | "run_started"
    | "checkpoint"
    | "policy_ask"
    | "policy_decision";
  [k: string]: unknown;
}

// ---- Safety net: checkpoints + command policy ----------------------------

export interface Checkpoint {
  id: string;
  workspace: string;
  label: string;
  createdAt: number;
  gitSha: string;
  parentSha: string;
  runId?: string;
  kind: "auto-pre-run" | "auto-pre-restore" | "manual";
  hadChanges: boolean;
}

export interface CommandPolicy {
  version: 1;
  deny: string[];
  allow: string[];
  trusted: string[];
  /** YOLO mode — auto-approve everything except hard-deny patterns. */
  autoApprove?: boolean;
}

export type PolicyDecision = "allow_once" | "allow_always" | "deny";

export interface AgentCommandSummary {
  id: string;
  cmd: string;
  cwd: string;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  exitCode: number;
  truncated: boolean;
  stdoutBytes: number;
  stderrBytes: number;
}

export interface AgentCommandRun extends Omit<AgentCommandSummary, "stdoutBytes" | "stderrBytes"> {
  stdout: string;
  stderr: string;
}

export interface ChatSessionMeta {
  id: string;
  title: string;
  workspace: string;
  mode?: "ask" | "agent";
  createdAt: number;
  updatedAt: number;
  turnCount: number;
}

// ---- Source control (git) -------------------------------------------------

export interface GitFileEntry {
  path: string;
  origPath: string | null;
  code: string;
  indexStatus: string;
  workStatus: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

export interface GitStatus {
  ok: boolean;
  workspace?: string;
  branch?: string;
  upstream?: string | null;
  ahead?: number;
  behind?: number;
  detached?: boolean;
  files?: GitFileEntry[];
  reason?: string;
  error?: string;
}

export interface GitLogEntry {
  hash: string;
  abbrev: string;
  parents: string[];
  author: string;
  email: string;
  date: string;
  ts: number;
  subject: string;
}

export interface LlmProfileSlot {
  baseUrl: string;
  model: string;
  /** Per-provider API key present in `llm-profiles.json` (not shared across providers). */
  apiKeySet?: boolean;
}

export interface IntegrationMeta {
  defaultBaseUrl: string;
  kind: "managed_cloud" | "self_hosted";
  description: string;
}

export interface SettingsPayload {
  LLM_PROVIDER: string;
  BASE_URL: string;
  MODEL: string;
  /** Saved per provider id (`chatgpt`, `gemini`, …) — independent of flat `.env` rows. */
  PROFILES?: Record<string, LlmProfileSlot>;
  /** Backend registry: built-in endpoints for third-party APIs. */
  INTEGRATIONS?: Record<string, IntegrationMeta>;
  MAX_CONTEXT_FILES: number;
  MAX_ITERATIONS: number;
  /** Agent/Ask instruction depth. Legacy `compact` is normalized to `balanced` by the server. */
  PROMPT_MODE?: "minimal" | "economical" | "balanced" | "detailed" | "verbose";
  /** Hard cap on completion tokens per LLM request (64–8192). `0` = use Prompt mode defaults. */
  LLM_MAX_TOKENS?: number;
  OPENAI_API_KEY_SET: boolean;
  OPENAI_API_KEY?: string;
  ENV_FILE?: string;
  PROFILES_FILE?: string;
}

async function jsonOrThrow(r: Response) {
  if (!r.ok) {
    let msg = `${r.status}`;
    try { msg = (await r.json()).error || msg; } catch { /* noop */ }
    throw new Error(msg);
  }
  return r.json();
}

export const api = {
  health: () => apiFetch(`${BASE}/health`).then((r) => r.json()),

  getWorkspace: (): Promise<{ workspace: string }> => apiFetch(`${BASE}/workspace`).then(jsonOrThrow),
  setWorkspace: (p: string) => apiFetch(`${BASE}/workspace`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: p }),
  }).then(jsonOrThrow) as Promise<{ workspace: string }>,

  fsHome: (): Promise<{ home: string; roots: { label: string; path: string }[] }> =>
    apiFetch(`${BASE}/fs/home`).then(jsonOrThrow),
  fsBrowse: (p: string, hidden = false): Promise<BrowseResult> =>
    apiFetch(`${BASE}/fs/browse?path=${encodeURIComponent(p)}&hidden=${hidden ? 1 : 0}`).then(jsonOrThrow),

  listFiles: (dir = "."): Promise<{ dir: string; items: FileEntry[] }> =>
    apiFetch(`${BASE}/files?dir=${encodeURIComponent(dir)}`).then(jsonOrThrow),

  readFile: (path: string): Promise<{ path: string; content: string }> =>
    apiFetch(`${BASE}/file?path=${encodeURIComponent(path)}`).then(jsonOrThrow),

  writeFile: (path: string, content: string) => apiFetch(`${BASE}/file`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, content }),
  }).then(jsonOrThrow),

  createEntry: (path: string, kind: "file" | "dir") => apiFetch(`${BASE}/entries`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, kind }),
  }).then(jsonOrThrow),

  deleteEntry: (path: string) => apiFetch(`${BASE}/entries?path=${encodeURIComponent(path)}`, {
    method: "DELETE",
  }).then(jsonOrThrow),

  rename: (from: string, to: string) => apiFetch(`${BASE}/fs/rename`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from, to }),
  }).then(jsonOrThrow),

  copyEntry: (from: string, to: string): Promise<{ ok: true; path: string }> =>
    apiFetch(`${BASE}/entries/copy`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from, to }),
    }).then(jsonOrThrow),

  search: (query: string): Promise<{ query: string; hits: { file: string; line: number; text: string }[] }> =>
    apiFetch(`${BASE}/search?query=${encodeURIComponent(query)}`).then(jsonOrThrow),

  runCommand: (cmd: string) => apiFetch(`${BASE}/terminal`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cmd }),
  }).then(jsonOrThrow),

  // ---- Source control (git) ----------------------------------------------
  gitStatus: (): Promise<GitStatus> => apiFetch(`${BASE}/git/status`).then(jsonOrThrow),
  gitDiff: (path: string, opts?: { staged?: boolean; untracked?: boolean }):
    Promise<{ path: string; staged: boolean; untracked: boolean; diff: string }> => {
      const qs = new URLSearchParams({ path });
      if (opts?.staged) qs.set("staged", "1");
      if (opts?.untracked) qs.set("untracked", "1");
      return apiFetch(`${BASE}/git/diff?${qs.toString()}`).then(jsonOrThrow);
    },
  gitStage: (paths: string[]) => apiFetch(`${BASE}/git/stage`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paths }),
  }).then(jsonOrThrow),
  gitUnstage: (paths: string[]) => apiFetch(`${BASE}/git/unstage`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paths }),
  }).then(jsonOrThrow),
  gitDiscard: (paths: string[]) => apiFetch(`${BASE}/git/discard`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paths }),
  }).then(jsonOrThrow),
  gitCommit: (message: string, opts?: { stageAll?: boolean; signoff?: boolean }):
    Promise<{ ok: true; output: string }> => apiFetch(`${BASE}/git/commit`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, stageAll: opts?.stageAll, signoff: opts?.signoff }),
    }).then(jsonOrThrow),
  gitLog: (limit = 50): Promise<{ ok: boolean; entries: GitLogEntry[] }> =>
    apiFetch(`${BASE}/git/log?limit=${limit}`).then(jsonOrThrow),
  gitInit: (): Promise<{ ok: true; alreadyRepo?: boolean }> =>
    apiFetch(`${BASE}/git/init`, { method: "POST" }).then(jsonOrThrow),
  gitApply: (patch: string, mode: "stage" | "discard" | "unstage"): Promise<{ ok: true }> =>
    apiFetch(`${BASE}/git/apply`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ patch, mode }),
    }).then(jsonOrThrow),

  getSettings: (): Promise<SettingsPayload> => apiFetch(`${BASE}/settings`).then(jsonOrThrow),
  saveSettings: (s: Partial<SettingsPayload>) => apiFetch(`${BASE}/settings`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(s),
  }).then(jsonOrThrow),

  /**
   * Probe a local Ollama instance for its installed models. Returns
   * `{ ok: false }` if Ollama isn't reachable — callers should treat that
   * as "fall back to a free-text model field" rather than a hard error.
   */
  ollamaModels: (base?: string): Promise<{ ok: boolean; base?: string; models?: string[]; error?: string }> => {
    const qs = base ? `?base=${encodeURIComponent(base)}` : "";
    return apiFetch(`${BASE}/ollama/models${qs}`).then(jsonOrThrow);
  },

  /** OpenAI-compatible `GET /v1/models` (LM Studio, Ollama /v1, vLLM, api.openai.com, …). */
  openaiCompatibleModels: (base?: string): Promise<{ ok: boolean; base?: string; models?: string[]; error?: string }> => {
    const qs = base !== undefined && base !== "" ? `?base=${encodeURIComponent(base)}` : "";
    return apiFetch(`${BASE}/openai-compatible/models${qs}`).then(jsonOrThrow);
  },

  // ---- Checkpoints (workspace snapshots) --------------------------------
  listCheckpoints: (): Promise<{ workspace: string; checkpoints: Checkpoint[] }> =>
    apiFetch(`${BASE}/checkpoints`).then(jsonOrThrow),
  createCheckpoint: (label?: string): Promise<{ ok: true; checkpoint: Checkpoint }> =>
    apiFetch(`${BASE}/checkpoints`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label }),
    }).then(jsonOrThrow),
  restoreCheckpoint: (id: string): Promise<{ ok: true; restored: Checkpoint; safetyCheckpoint: Checkpoint | null }> =>
    apiFetch(`${BASE}/checkpoints/${encodeURIComponent(id)}/restore`, { method: "POST" }).then(jsonOrThrow),
  deleteCheckpoint: (id: string): Promise<{ ok: true }> =>
    apiFetch(`${BASE}/checkpoints/${encodeURIComponent(id)}`, { method: "DELETE" }).then(jsonOrThrow),

  // ---- Command policy ---------------------------------------------------
  getPolicy: (): Promise<{ workspace: string; policy: CommandPolicy }> =>
    apiFetch(`${BASE}/policy`).then(jsonOrThrow),
  savePolicy: (p: CommandPolicy): Promise<{ ok: true; policy: CommandPolicy }> =>
    apiFetch(`${BASE}/policy`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(p),
    }).then(jsonOrThrow),
  trustPattern: (pattern: string): Promise<{ ok: true; policy: CommandPolicy }> =>
    apiFetch(`${BASE}/policy/trust`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pattern }),
    }).then(jsonOrThrow),
  setAutoApprove: (value: boolean): Promise<{ ok: true; autoApprove: boolean; policy: CommandPolicy }> =>
    apiFetch(`${BASE}/policy/auto-approve`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
    }).then(jsonOrThrow),

  // ---- Approval bridge for policy_ask events ----------------------------
  respondApproval: (
    askId: string,
    decision: PolicyDecision,
    editedCmd?: string,
  ): Promise<{ ok: true }> =>
    apiFetch(`${BASE}/agent/approvals/${encodeURIComponent(askId)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, editedCmd }),
    }).then(jsonOrThrow),

  // ---- Chat history (server-backed) ---------------------------------------
  listChats: (workspace: string): Promise<{ workspace: string; sessions: ChatSessionMeta[] }> =>
    apiFetch(`${BASE}/chats?workspace=${encodeURIComponent(workspace)}`).then(jsonOrThrow),
  getChat: <T = unknown>(workspace: string, id: string): Promise<T> =>
    apiFetch(`${BASE}/chats/${encodeURIComponent(id)}?workspace=${encodeURIComponent(workspace)}`).then(jsonOrThrow),
  putChat: <T = unknown>(workspace: string, session: T & { id: string }) => apiFetch(
    `${BASE}/chats/${encodeURIComponent(session.id)}?workspace=${encodeURIComponent(workspace)}`,
    { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(session) },
  ).then(jsonOrThrow),
  patchChat: (workspace: string, id: string, patch: Record<string, unknown>) => apiFetch(
    `${BASE}/chats/${encodeURIComponent(id)}?workspace=${encodeURIComponent(workspace)}`,
    { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) },
  ).then(jsonOrThrow),
  deleteChat: (workspace: string, id: string) => apiFetch(
    `${BASE}/chats/${encodeURIComponent(id)}?workspace=${encodeURIComponent(workspace)}`,
    { method: "DELETE" },
  ).then(jsonOrThrow),
  searchChats: (
    workspace: string,
    query: string,
  ): Promise<{ workspace: string; query: string; hits: { id: string; title: string; updatedAt: number; snippet: string; matches: number }[] }> => apiFetch(
    `${BASE}/chats/search?workspace=${encodeURIComponent(workspace)}&q=${encodeURIComponent(query)}`,
  ).then(jsonOrThrow),
  exportChatsUrl: (workspace: string) =>
    `${BASE}/chats/export?workspace=${encodeURIComponent(workspace)}`,
  importChats: (workspace: string, sessions: unknown[]): Promise<{ ok: true; imported: number; total: number }> => apiFetch(
    `${BASE}/chats/import?workspace=${encodeURIComponent(workspace)}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessions }) },
  ).then(jsonOrThrow),

  // ---- Agent command log -------------------------------------------------
  listAgentCommands: (): Promise<{ runs: AgentCommandSummary[] }> =>
    apiFetch(`${BASE}/agent/commands`).then(jsonOrThrow),
  getAgentCommand: (id: string): Promise<AgentCommandRun> =>
    apiFetch(`${BASE}/agent/commands/${encodeURIComponent(id)}`).then(jsonOrThrow),
  clearAgentCommands: (): Promise<{ ok: true; removed: number }> =>
    apiFetch(`${BASE}/agent/commands`, { method: "DELETE" }).then(jsonOrThrow),
  deleteAgentCommand: (id: string): Promise<{ ok: true; id: string }> =>
    apiFetch(`${BASE}/agent/commands/${encodeURIComponent(id)}`, { method: "DELETE" }).then(jsonOrThrow),
  /**
   * Subscribe to live updates from the backend agent command log via SSE.
   * The Terminals panel also polls `listAgentCommands` periodically — SSE alone
   * can go stale (browser limits, proxies, sleep). Polling covers missed events.
   * Returns a `close` function the caller should invoke on cleanup.
   */
  streamAgentCommands(handlers: {
    onHello?: (runs: AgentCommandSummary[]) => void;
    onRun?: (run: AgentCommandSummary) => void;
    onClear?: () => void;
    onDelete?: (id: string) => void;
    onError?: (err: Event) => void;
  }): { close: () => void } {
    const es = new EventSource(`${BASE}/agent/commands/stream`);
    es.addEventListener("hello", (ev) => {
      try { handlers.onHello?.(JSON.parse((ev as MessageEvent).data).runs); } catch { /* noop */ }
    });
    es.addEventListener("run", (ev) => {
      try { handlers.onRun?.(JSON.parse((ev as MessageEvent).data)); } catch { /* noop */ }
    });
    es.addEventListener("clear", () => handlers.onClear?.());
    es.addEventListener("delete", (ev) => {
      try { handlers.onDelete?.(JSON.parse((ev as MessageEvent).data).id); } catch { /* noop */ }
    });
    es.onerror = (e) => handlers.onError?.(e);
    return { close: () => es.close() };
  },

  revertDiff: (diff: string): Promise<{ ok: true; mode: string; path: string }> =>
    apiFetch(`${BASE}/diff/revert`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ diff }),
    }).then(jsonOrThrow) as Promise<{ ok: true; mode: string; path: string }>,

  revertHunk: (diff: string, hunkIndex: number): Promise<{ ok: true; mode: string; path: string; hunkIndex: number }> =>
    apiFetch(`${BASE}/diff/revert-hunk`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ diff, hunkIndex }),
    }).then(jsonOrThrow) as Promise<{ ok: true; mode: string; path: string; hunkIndex: number }>,

  runAgentStream(
    task: string,
    onEvent: (e: AgentEvent) => void,
    opts: { mode?: "ask" | "agent" } = {},
  ): { close: () => void; done: Promise<void> } {
    const ctrl = new AbortController();
    const done = (async () => {
      const res = await apiFetch(`${BASE}/agent/run?stream=1`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ task, mode: opts.mode ?? "agent" }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        throw new Error(`agent run failed: ${res.status} ${text}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const lines = block.split("\n");
          let event = "message";
          let data = "";
          for (const ln of lines) {
            if (ln.startsWith("event:")) event = ln.slice(6).trim();
            else if (ln.startsWith("data:")) data += ln.slice(5).trim();
          }
          if (data) {
            try {
              const parsed = JSON.parse(data);
              onEvent({ type: event as AgentEvent["type"], ...parsed });
            } catch {
              onEvent({ type: "log", level: "error", message: `bad SSE payload: ${data}` } as AgentEvent);
            }
          }
        }
      }
    })();
    return { close: () => ctrl.abort(), done };
  },

  // ---- Agent sessions (background mode) ----------------------------------
  // Sessions run independently of client connections. Agents continue even
  // if the browser tab is closed/refreshed.

  /** Start a new background agent session */
  startSession: (
    task: string,
    mode: "ask" | "agent" = "agent",
    images?: { dataUrl: string; name: string }[],
  ): Promise<{ ok: true; session: AgentSession }> =>
    apiFetch(`${BASE}/agent/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task, mode, images }),
    }).then(jsonOrThrow),

  /** List all sessions for current workspace */
  listSessions: (): Promise<{ sessions: AgentSession[]; stats: SessionStats; workspace: string }> =>
    apiFetch(`${BASE}/agent/sessions`).then(jsonOrThrow),

  /** Get currently running sessions for current workspace */
  getRunningSessions: (): Promise<{ running: AgentSession[]; workspace: string }> =>
    apiFetch(`${BASE}/agent/sessions/running`).then(jsonOrThrow),

  /** Get ALL running sessions across ALL workspaces (for workspace manager) */
  getAllRunningSessions: (): Promise<{ running: AgentSession[] }> =>
    apiFetch(`${BASE}/agent/sessions/all-running`).then(jsonOrThrow),

  /** Get a specific session */
  getSession: (id: string): Promise<{ session: AgentSession }> =>
    apiFetch(`${BASE}/agent/sessions/${encodeURIComponent(id)}`).then(jsonOrThrow),

  /** Abort a running session */
  abortSession: (id: string): Promise<{ ok: true; id: string }> =>
    apiFetch(`${BASE}/agent/sessions/${encodeURIComponent(id)}/abort`, {
      method: "POST",
    }).then(jsonOrThrow),

  /** Delete a completed session */
  deleteSession: (id: string): Promise<{ ok: true; id: string }> =>
    apiFetch(`${BASE}/agent/sessions/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }).then(jsonOrThrow),

  /**
   * Subscribe to a session's event stream via SSE.
   * Replays all past events then streams new ones in real-time.
   * Agent continues running even if this connection is closed.
   */
  streamSession(
    sessionId: string,
    onEvent: (e: AgentEvent) => void,
    onSessionInfo?: (info: SessionInfo) => void,
    onSessionEnded?: (end: { status: string; result?: string; error?: string }) => void,
  ): { close: () => void; done: Promise<void> } {
    const ctrl = new AbortController();
    const done = (async () => {
      const res = await apiFetch(`${BASE}/agent/sessions/${encodeURIComponent(sessionId)}/stream`, {
        headers: { Accept: "text/event-stream" },
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        throw new Error(`session stream failed: ${res.status} ${text}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let eventsThisTurn = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const lines = block.split("\n");
          let event = "message";
          let data = "";
          for (const ln of lines) {
            if (ln.startsWith("event:")) event = ln.slice(6).trim();
            else if (ln.startsWith("data:")) data += ln.slice(5).trim();
          }
          if (data) {
            try {
              const parsed = JSON.parse(data);
              if (event === "session_info") {
                onSessionInfo?.(parsed);
              } else if (event === "session_ended") {
                onSessionEnded?.(parsed);
              } else {
                onEvent({ type: event as AgentEvent["type"], ...parsed });
              }
            } catch {
              onEvent({ type: "log", level: "error", message: `bad SSE payload: ${data}` } as AgentEvent);
            }
          }
          eventsThisTurn += 1;
          // Yield so a tight SSE burst (replay + stream) doesn’t freeze the tab in one macrotask.
          if (eventsThisTurn >= 40) {
            eventsThisTurn = 0;
            await new Promise<void>((r) => setTimeout(r, 0));
          }
        }
      }
    })();
    return { close: () => ctrl.abort(), done };
  },
};

// ---- Session types -------------------------------------------------------

export type SessionStatus = "running" | "completed" | "error" | "aborted";

export interface AgentSession {
  id: string;
  task: string;
  mode: "ask" | "agent";
  status: SessionStatus;
  events: AgentEvent[];
  result?: { result: string; iterations: number; diffs: string[] };
  error?: string;
  createdAt: number;
  completedAt?: number;
  workspace: string;
}

export interface SessionStats {
  total: number;
  running: number;
  completed: number;
  error: number;
}

export interface SessionInfo {
  id: string;
  task: string;
  mode: "ask" | "agent";
  status: SessionStatus;
  createdAt: number;
  completedAt?: number;
  eventCount: number;
}
