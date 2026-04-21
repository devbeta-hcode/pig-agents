import { EventEmitter } from "node:events";

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
}

export type AgentCommandSummary = Omit<AgentCommandRun, "stdout" | "stderr"> & {
  stdoutBytes: number;
  stderrBytes: number;
};

const MAX_RUNS = 100;
const ring: AgentCommandRun[] = [];
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
    stdoutBytes: Buffer.byteLength(r.stdout, "utf8"),
    stderrBytes: Buffer.byteLength(r.stderr, "utf8"),
  };
}

export function listAgentCommands(): AgentCommandSummary[] {
  // Newest first — that's what the UI wants.
  return ring.slice().reverse().map(summarize);
}

export function getAgentCommand(id: string): AgentCommandRun | undefined {
  return ring.find((r) => r.id === id);
}

export function clearAgentCommands(): number {
  const n = ring.length;
  ring.length = 0;
  bus.emit("clear");
  return n;
}

export function deleteAgentCommand(id: string): boolean {
  const i = ring.findIndex((r) => r.id === id);
  if (i < 0) return false;
  ring.splice(i, 1);
  bus.emit("delete", id);
  return true;
}

export function subscribeAgentCommands(
  onRun: (r: AgentCommandSummary) => void,
  onClear: () => void,
  onDelete?: (id: string) => void,
): () => void {
  const r = (run: AgentCommandRun) => onRun(summarize(run));
  const d = (id: string) => onDelete?.(id);
  bus.on("run", r);
  bus.on("clear", onClear);
  bus.on("delete", d);
  return () => {
    bus.off("run", r);
    bus.off("clear", onClear);
    bus.off("delete", d);
  };
}
