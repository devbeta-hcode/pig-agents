/**
 * Desktop API client — talks to the Electron main process over IPC
 * (`window.pig`). No HTTP, no fetch, no SSE/WebSocket. Method signatures
 * mirror the old web client so UI components stay unchanged.
 */
import { pig } from "./pig.js";

/** Kept for source-compatibility with the web client; unused on desktop. */
export const WORKSPACE_HEADER = "X-Pig-Agents-Workspace";

const SESSION_WS_KEY = "pig-agents.workspace.v1";

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
    | "activity"
    | "iter_start"
    | "token"
    | "reasoning"
    | "thought"
    | "tool_payload_streaming"
    | "tool_disk_settled"
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
    | "policy_decision"
    | "context_usage";
  [k: string]: unknown;
}

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
  autoApprove?: boolean;
  autoApproveWeb?: boolean;
  autoApproveDelete?: boolean;
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
  apiKeySet?: boolean;
}

export interface IntegrationMeta {
  defaultBaseUrl: string;
  kind: "managed_cloud" | "self_hosted";
  label?: string;
  description: string;
}

export interface SettingsPayload {
  LLM_PROVIDER: string;
  BASE_URL: string;
  MODEL: string;
  PROFILES?: Record<string, LlmProfileSlot>;
  INTEGRATIONS?: Record<string, IntegrationMeta>;
  PROVIDER_IDS?: string[];
  MAX_CONTEXT_FILES: number;
  MAX_ITERATIONS: number;
  PROMPT_MODE?: "minimal" | "economical" | "balanced" | "detailed" | "verbose";
  LLM_MAX_TOKENS?: number;
  OPENAI_API_KEY_SET: boolean;
  OPENAI_API_KEY?: string;
  ENV_FILE?: string;
  PROFILES_FILE?: string;
}

export const api = {
  health: () => pig.rpc("health", []),

  getWorkspace: (): Promise<{ workspace: string }> => pig.rpc("workspaceGet", []),
  setWorkspace: (p: string): Promise<{ workspace: string }> => pig.rpc("workspaceSet", [p]),

  fsHome: (): Promise<{ home: string; roots: { label: string; path: string }[] }> => pig.rpc("fsHome", []),
  fsBrowse: (p: string, hidden = false): Promise<BrowseResult> => pig.rpc("fsBrowse", [p, hidden]),

  listFiles: (dir = "."): Promise<{ dir: string; items: FileEntry[] }> => pig.rpc("listFilesSvc", [dir]),
  readFile: (path: string): Promise<{ path: string; content: string }> => pig.rpc("readFileSvc", [path]),
  writeFile: (path: string, content: string) => pig.rpc("writeFileSvc", [path, content]),
  createEntry: (path: string, kind: "file" | "dir") => pig.rpc("createEntrySvc", [path, kind]),
  deleteEntry: (path: string) => pig.rpc("deleteEntrySvc", [path]),
  rename: (from: string, to: string) => pig.rpc("renameSvc", [from, to]),
  copyEntry: (from: string, to: string): Promise<{ ok: true; path: string }> => pig.rpc("copyEntrySvc", [from, to]),
  search: (query: string): Promise<{ query: string; hits: { file: string; line: number; text: string }[] }> =>
    pig.rpc("searchSvc", [query]),

  runCommand: (cmd: string) => pig.rpc("runCommandSvc", [cmd]),

  // ---- Source control (git) ----------------------------------------------
  gitStatus: (): Promise<GitStatus> => pig.rpc("gitStatus", []),
  gitDiff: (path: string, opts?: { staged?: boolean; untracked?: boolean }):
    Promise<{ path: string; staged: boolean; untracked: boolean; diff: string }> => pig.rpc("gitDiff", [path, opts]),
  gitStage: (paths: string[]) => pig.rpc("gitStage", [paths]),
  gitUnstage: (paths: string[]) => pig.rpc("gitUnstage", [paths]),
  gitDiscard: (paths: string[]) => pig.rpc("gitDiscard", [paths]),
  gitCommit: (message: string, opts?: { stageAll?: boolean; signoff?: boolean }): Promise<{ ok: true; output: string }> =>
    pig.rpc("gitCommit", [message, opts]),
  gitLog: (limit = 50): Promise<{ ok: boolean; entries: GitLogEntry[] }> => pig.rpc("gitLog", [limit]),
  gitInit: (): Promise<{ ok: true; alreadyRepo?: boolean }> => pig.rpc("gitInit", []),
  gitApply: (patch: string, mode: "stage" | "discard" | "unstage"): Promise<{ ok: true }> =>
    pig.rpc("gitApply", [patch, mode]),

  getSettings: (): Promise<SettingsPayload> => pig.rpc("settingsGet", []),
  contextPreview: (task: string, mode: "ask" | "agent" = "agent") =>
    pig.rpc("contextPreview", [task, mode]),
  saveSettings: (s: Partial<SettingsPayload>) => pig.rpc("settingsSave", [s]),

  ollamaModels: (base?: string): Promise<{ ok: boolean; base?: string; models?: string[]; error?: string }> =>
    pig.rpc("ollamaModels", [base]),
  openaiCompatibleModels: (base?: string): Promise<{ ok: boolean; base?: string; models?: string[]; error?: string }> =>
    pig.rpc("openaiCompatibleModels", [base]),

  // ---- Checkpoints --------------------------------------------------------
  listCheckpoints: (): Promise<{ workspace: string; checkpoints: Checkpoint[] }> => pig.rpc("checkpointsList", []),
  createCheckpoint: (label?: string): Promise<{ ok: true; checkpoint: Checkpoint }> => pig.rpc("checkpointCreate", [label]),
  restoreCheckpoint: (id: string): Promise<{ ok: true; restored: Checkpoint; safetyCheckpoint: Checkpoint | null }> =>
    pig.rpc("checkpointRestore", [id]),
  deleteCheckpoint: (id: string): Promise<{ ok: true }> => pig.rpc("checkpointDelete", [id]),

  // ---- Command policy -----------------------------------------------------
  getPolicy: (): Promise<{ workspace: string; policy: CommandPolicy }> => pig.rpc("policyGet", []),
  savePolicy: (p: CommandPolicy): Promise<{ ok: true; policy: CommandPolicy }> => pig.rpc("policySave", [p]),
  trustPattern: (pattern: string): Promise<{ ok: true; policy: CommandPolicy }> => pig.rpc("policyTrustPattern", [pattern]),
  setAutoApprove: (value: boolean): Promise<{ ok: true; autoApprove: boolean; policy: CommandPolicy }> =>
    pig.rpc("policyAutoApprove", [value]),
  setAutoApproveWeb: (value: boolean): Promise<{ ok: true; autoApproveWeb: boolean; policy: CommandPolicy }> =>
    pig.rpc("policyAutoApproveWeb", [value]),
  setAutoApproveDelete: (value: boolean): Promise<{ ok: true; autoApproveDelete: boolean; policy: CommandPolicy }> =>
    pig.rpc("policyAutoApproveDelete", [value]),

  // ---- Approval bridge ----------------------------------------------------
  respondApproval: (askId: string, decision: PolicyDecision, editedCmd?: string): Promise<{ ok: true }> =>
    pig.rpc("approvalRespond", [askId, decision, editedCmd]),

  // ---- Chat history -------------------------------------------------------
  listChats: (workspace: string): Promise<{ workspace: string; sessions: ChatSessionMeta[] }> =>
    pig.rpc("chatsList", [workspace]),
  getChat: <T = unknown>(workspace: string, id: string): Promise<T> => pig.rpc("chatGet", [workspace, id]),
  putChat: <T = unknown>(workspace: string, session: T & { id: string }) => pig.rpc("chatPut", [workspace, session]),
  patchChat: (workspace: string, id: string, patch: Record<string, unknown>) => pig.rpc("chatPatch", [workspace, id, patch]),
  deleteChat: (workspace: string, id: string) => pig.rpc("chatDelete", [workspace, id]),
  searchChats: (
    workspace: string,
    query: string,
  ): Promise<{ workspace: string; query: string; hits: { id: string; title: string; updatedAt: number; snippet: string; matches: number }[] }> =>
    pig.rpc("chatsSearch", [workspace, query]),
  exportChats: (workspace: string): Promise<{ kind: string; workspace: string; exportedAt: number; sessions: unknown[] }> =>
    pig.rpc("chatsExport", [workspace]),
  importChats: (workspace: string, sessions: unknown[]): Promise<{ ok: true; imported: number; total: number }> =>
    pig.rpc("chatsImport", [workspace, sessions]),

  // ---- Agent command log --------------------------------------------------
  listAgentCommands: (): Promise<{ runs: AgentCommandSummary[] }> => pig.rpc("agentCommandsList", []),
  getAgentCommand: (id: string): Promise<AgentCommandRun> => pig.rpc("agentCommandGet", [id]),
  clearAgentCommands: (): Promise<{ ok: true; removed: number }> => pig.rpc("agentCommandsClear", []),
  deleteAgentCommand: (id: string): Promise<{ ok: true; id: string }> => pig.rpc("agentCommandDelete", [id]),

  streamAgentCommands(handlers: {
    onHello?: (runs: AgentCommandSummary[], live: Array<{ id: string; cmd: string; cwd: string; startedAt: number; output: string }>) => void;
    onRun?: (run: AgentCommandSummary) => void;
    onClear?: () => void;
    onDelete?: (id: string) => void;
    onError?: (err: Event) => void;
    onRunStart?: (info: { id: string; cmd: string; cwd: string; startedAt: number }) => void;
    onRunChunk?: (chunk: { id: string; stream: "stdout" | "stderr"; text: string }) => void;
  }): { close: () => void } {
    const h = pig.streamOpen("commandLog", {}, (m: Record<string, unknown>) => {
      switch (m.kind) {
        case "hello": handlers.onHello?.((m.runs as AgentCommandSummary[]) ?? [], (m.live as never[]) ?? []); break;
        case "run": handlers.onRun?.(m.run as AgentCommandSummary); break;
        case "clear": handlers.onClear?.(); break;
        case "delete": handlers.onDelete?.(m.id as string); break;
        case "run_start": handlers.onRunStart?.(m.info as never); break;
        case "run_chunk": handlers.onRunChunk?.(m.chunk as never); break;
      }
    });
    return { close: h.close };
  },

  revertDiff: (diff: string): Promise<{ ok: true; mode: string; path: string }> => pig.rpc("diffRevert", [diff]),
  revertHunk: (diff: string, hunkIndex: number): Promise<{ ok: true; mode: string; path: string; hunkIndex: number }> =>
    pig.rpc("diffRevertHunk", [diff, hunkIndex]),

  runAgentStream(
    task: string,
    onEvent: (e: AgentEvent) => void,
    opts: { mode?: "ask" | "agent" } = {},
  ): { close: () => void; done: Promise<void> } {
    const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    let resolveDone!: () => void;
    const done = new Promise<void>((res) => { resolveDone = res; });
    const h = pig.streamOpen("agentRun", { task, mode: opts.mode ?? "agent", runId }, (m: AgentEvent) => {
      if (m.type === "done") { onEvent(m); resolveDone(); }
      else if (m.type === "error") { onEvent(m); resolveDone(); }
      else onEvent(m);
    });
    return {
      close: () => { h.close(); resolveDone(); },
      done,
    };
  },

  // ---- Agent sessions (background mode) -----------------------------------
  startSession: (
    task: string,
    mode: "ask" | "agent" = "agent",
    images?: { dataUrl: string; name: string }[],
  ): Promise<{ ok: true; session: AgentSession }> => pig.rpc("sessionStart", [task, mode, images]),

  listSessions: (): Promise<{ sessions: AgentSession[]; stats: SessionStats; workspace: string }> =>
    pig.rpc("sessionList", []),
  getRunningSessions: (): Promise<{ running: AgentSession[]; workspace: string }> => pig.rpc("sessionRunning", []),
  getAllRunningSessions: (): Promise<{ running: AgentSession[] }> => pig.rpc("sessionAllRunning", []),
  getSession: (id: string): Promise<{ session: AgentSession }> => pig.rpc("sessionGet", [id]),
  abortSession: (id: string): Promise<{ ok: true; id: string }> => pig.rpc("sessionAbort", [id]),
  deleteSession: (id: string): Promise<{ ok: true; id: string }> => pig.rpc("sessionDelete", [id]),

  streamSession(
    sessionId: string,
    onEvent: (e: AgentEvent) => void,
    onSessionInfo?: (info: SessionInfo) => void,
    onSessionEnded?: (end: { status: string; result?: string; error?: string }) => void,
  ): { close: () => void; done: Promise<void> } {
    let resolveDone!: () => void;
    const done = new Promise<void>((res) => { resolveDone = res; });
    const h = pig.streamOpen("session", { sessionId }, (m: Record<string, unknown>) => {
      const t = (m as { type?: string }).type;
      if (t === "session_info") onSessionInfo?.(m as unknown as SessionInfo);
      else if (t === "session_ended") { onSessionEnded?.(m as never); resolveDone(); }
      else onEvent(m as unknown as AgentEvent);
    });
    return { close: () => { h.close(); resolveDone(); }, done };
  },
};

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
