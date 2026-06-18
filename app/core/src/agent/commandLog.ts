import { EventEmitter } from "node:events";
import { killBackgroundProcess, isBackgroundProcessRunning } from "../tools/smartCommand.js";

/**
 * Tracks every shell command the agent runs through the `run_command` tool so
 * the IDE can surface them as virtual terminals (read-only) the user can
 * inspect just like real PTY tabs.
 */

export interface AgentCommandRun {
  id: string;
  cmd: string;
  cwd: string;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  /** PID of the child process, set for background (long-running) commands. */
  pid?: number;
  /** True when the child is still running in background after runSmartCommand returned. */
  background?: boolean;
}

export type AgentCommandSummary = Omit<AgentCommandRun, "stdout" | "stderr"> & {
  stdoutBytes: number;
  stderrBytes: number;
};

export type LiveAgentCommand = {
  id: string;
  cmd: string;
  cwd: string;
  startedAt: number;
  output: string;
  pid?: number;
  background?: boolean;
};

/** Lightweight token for an in-progress agent command. */
export interface PendingCommandHandle {
  readonly id: string;
  /** Register the OS PID once the child spawns so dismiss can kill it. */
  setPid(pid: number): void;
  appendChunk(stream: "stdout" | "stderr", text: string): void;
  complete(result: Omit<AgentCommandRun, "id">): AgentCommandRun;
}

const MAX_RUNS = 100;
const ring: AgentCommandRun[] = [];
/** In-progress runs — kept until complete() is called so reconnecting clients can replay them. */
const pending = new Map<string, { id: string; cmd: string; cwd: string; startedAt: number; output: string; pid?: number }>();
const bus = new EventEmitter();
bus.setMaxListeners(50);

let counter = 0;
function nextId(): string {
  counter += 1;
  return `cmd_${Date.now().toString(36)}_${counter.toString(36)}`;
}

export function recordAgentCommand(run: Omit<AgentCommandRun, "id">): AgentCommandRun {
  const full: AgentCommandRun = { id: nextId(), ...run };
  ring.push(full);
  if (ring.length > MAX_RUNS) ring.splice(0, ring.length - MAX_RUNS);
  bus.emit("run", full);
  return full;
}

/**
 * Start tracking an in-progress command. Immediately emits `run_start` on the
 * SSE bus so the frontend can open a live terminal tab. Returns a handle that
 * lets the caller stream chunks and finalise the record when done.
 */
export function startAgentCommand(cmd: string, cwd: string): PendingCommandHandle {
  const id = nextId();
  const startedAt = Date.now();
  pending.set(id, { id, cmd, cwd, startedAt, output: "" });
  bus.emit("run_start", { id, cmd, cwd, startedAt });

  const handle: PendingCommandHandle = {
    id,
    setPid(pid: number) {
      const p = pending.get(id);
      if (p) p.pid = pid;
    },
    appendChunk(stream, text) {
      const p = pending.get(id);
      if (p) p.output += text;
      bus.emit("run_chunk", { id, stream, text });
    },
    complete(result) {
      pending.delete(id);
      const full: AgentCommandRun = { id, ...result };
      ring.push(full);
      if (ring.length > MAX_RUNS) ring.splice(0, ring.length - MAX_RUNS);
      bus.emit("run", full);
      return full;
    },
  };
  return handle;
}

function summarize(r: AgentCommandRun): AgentCommandSummary {
  return {
    id: r.id,
    cmd: r.cmd,
    cwd: r.cwd,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    durationMs: r.durationMs,
    exitCode: r.exitCode,
    truncated: r.truncated,
    pid: r.pid,
    background: r.background,
    stdoutBytes: Buffer.byteLength(r.stdout, "utf8"),
    stderrBytes: Buffer.byteLength(r.stderr, "utf8"),
  };
}

export function listAgentCommands(): AgentCommandSummary[] {
  // Newest first — that's what the UI wants.
  return ring.slice().reverse().map(summarize);
}

/** Return currently-in-progress command snapshots (for SSE hello on reconnect). */
export function listPendingCommands(): LiveAgentCommand[] {
  return Array.from(pending.values()).map((p) => ({
    id: p.id,
    cmd: p.cmd,
    cwd: p.cwd,
    startedAt: p.startedAt,
    output: p.output,
    pid: p.pid,
  }));
}

/** Pending + background servers whose OS process is still alive. */
export function listLiveAgentCommands(): LiveAgentCommand[] {
  const out = new Map<string, LiveAgentCommand>();
  for (const p of pending.values()) {
    out.set(p.id, {
      id: p.id,
      cmd: p.cmd,
      cwd: p.cwd,
      startedAt: p.startedAt,
      output: p.output,
      pid: p.pid,
    });
  }
  for (const r of ring) {
    if (!r.pid || !r.background) continue;
    if (!isBackgroundProcessRunning(r.pid)) continue;
    if (out.has(r.id)) continue;
    out.set(r.id, {
      id: r.id,
      cmd: r.cmd,
      cwd: r.cwd,
      startedAt: r.startedAt,
      output: [r.stdout, r.stderr].filter(Boolean).join("\n").slice(-8000),
      pid: r.pid,
      background: true,
    });
  }
  return Array.from(out.values()).sort((a, b) => b.startedAt - a.startedAt);
}

export function getAgentCommand(id: string): AgentCommandRun | undefined {
  return ring.find((r) => r.id === id);
}

export function clearAgentCommands(): number {
  // Kill any background PIDs still tracked on the ring before clearing.
  for (const r of ring) {
    if (r.pid != null) killBackgroundProcess(r.pid);
  }
  // Also kill in-progress commands (pending map may have pids for queued long-runners).
  for (const p of pending.values()) {
    if (p.pid != null) killBackgroundProcess(p.pid);
  }
  const n = ring.length;
  ring.length = 0;
  bus.emit("clear");
  return n;
}

export function deleteAgentCommand(id: string): boolean {
  // Also try pending (user dismissed while the command was still running).
  const p = pending.get(id);
  if (p) {
    if (p.pid != null) killBackgroundProcess(p.pid);
    pending.delete(id);
    bus.emit("delete", id);
    return true;
  }
  const i = ring.findIndex((r) => r.id === id);
  if (i < 0) return false;
  const entry = ring[i];
  if (entry.pid != null) killBackgroundProcess(entry.pid);
  ring.splice(i, 1);
  bus.emit("delete", id);
  return true;
}

/**
 * Kill a running command's child process WITHOUT removing it from the pending
 * map or emitting "delete". The child's `close` event will resolve
 * `runSmartCommand` naturally (exit code 130 / "failed") so the agent can
 * continue to the next step. Use this when the user wants to interrupt a
 * specific command but keep the agent running.
 */
export function killAgentCommand(id: string): { ok: boolean; reason?: string } {
  const p = pending.get(id);
  if (p) {
    if (p.pid == null) return { ok: false, reason: "pid-not-ready" };
    killBackgroundProcess(p.pid);
    return { ok: true };
  }
  // Not in pending — may be a background server still tracked on the ring
  // (listLiveAgentCommands surfaces these as "running" too).
  const r = ring.find((x) => x.id === id);
  if (r) {
    if (r.pid != null && isBackgroundProcessRunning(r.pid)) {
      killBackgroundProcess(r.pid);
      return { ok: true };
    }
    return { ok: false, reason: "already-finished" };
  }
  return { ok: false, reason: "unknown-id" };
}

export interface CommandStreamCallbacks {
  onRun: (r: AgentCommandSummary) => void;
  onClear: () => void;
  onDelete?: (id: string) => void;
  /** Called when an in-progress command begins (before any chunks). */
  onRunStart?: (r: { id: string; cmd: string; cwd: string; startedAt: number }) => void;
  /** Called for each stdout/stderr chunk of an in-progress command. */
  onRunChunk?: (r: { id: string; stream: "stdout" | "stderr"; text: string }) => void;
}

export function subscribeAgentCommands(
  onRun: (r: AgentCommandSummary) => void,
  onClear: () => void,
  onDelete?: (id: string) => void,
  onRunStart?: (r: { id: string; cmd: string; cwd: string; startedAt: number }) => void,
  onRunChunk?: (r: { id: string; stream: "stdout" | "stderr"; text: string }) => void,
): () => void {
  const r = (run: AgentCommandRun) => onRun(summarize(run));
  const d = (id: string) => onDelete?.(id);
  const s = (info: { id: string; cmd: string; cwd: string; startedAt: number }) => onRunStart?.(info);
  const c = (chunk: { id: string; stream: "stdout" | "stderr"; text: string }) => onRunChunk?.(chunk);
  bus.on("run", r);
  bus.on("clear", onClear);
  bus.on("delete", d);
  bus.on("run_start", s);
  bus.on("run_chunk", c);
  return () => {
    bus.off("run", r);
    bus.off("clear", onClear);
    bus.off("delete", d);
    bus.off("run_start", s);
    bus.off("run_chunk", c);
  };
}

