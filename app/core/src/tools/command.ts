import { spawn } from "node:child_process";
import { getWorkspace } from "../utils/workspace.js";
import { killShellProcess, prepareAgentCommand, shellCommandSpawn } from "../utils/shell.js";
import { childSpawnEnv } from "./smartCommand.js";
import { rejectDestructiveShellCommand } from "./destructiveShellGuard.js";

function yieldEventLoop(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

const BYTES_BEFORE_YIELD = 40 * 1024;
const LINES_BEFORE_YIELD = 96;

// Strip ANSI escape codes from output
const ANSI_REGEX = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
function stripAnsi(str: string): string {
  return str.replace(ANSI_REGEX, "");
}

const BLOCKED = [
  /\brm\s+-rf\s+\/(?:\s|$)/,
  /\brm\s+-rf\s+~/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /:\s*\(\)\s*\{.*:\|.*&\s*\}/,
  /\bshutdown\b/,
  /\breboot\b/,
];

export interface CommandResult {
  cmd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
}

export async function runCommand(cmd: string, opts?: { cwd?: string; timeoutMs?: number; maxBytes?: number }): Promise<CommandResult> {
  const trimmed = prepareAgentCommand(cmd);
  if (!trimmed) throw new Error("Empty command");
  const destructive = rejectDestructiveShellCommand(trimmed);
  if (destructive) throw new Error(destructive);
  for (const re of BLOCKED) {
    if (re.test(trimmed)) throw new Error(`Command blocked by safety policy: ${trimmed}`);
  }

  const cwd = opts?.cwd ?? getWorkspace();
  const timeoutMs = opts?.timeoutMs ?? 60_000;
  const maxBytes = opts?.maxBytes ?? 256 * 1024;
  const shell = shellCommandSpawn(trimmed);

  return await new Promise<CommandResult>((resolve) => {
    const start = Date.now();
    const child = spawn(shell.file, shell.args, {
      cwd,
      // stdin must not be a pipe: commands that read from tty/stdin would
      // block forever (looks like a frozen backend until timeout).
      stdio: ["ignore", "pipe", "pipe"],
      env: childSpawnEnv({
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        GIT_PAGER: "cat",
        PAGER: "cat",
      }),
      ...(shell.killAsGroup ? { detached: true } : {}),
    });
    let outBuf = "";
    let errBuf = "";
    let truncated = false;
    let killed = false;
    let rollupBytes = 0;
    let rollupLines = 0;

    const timer = setTimeout(() => {
      killed = true;
      killShellProcess(child, "SIGKILL");
    }, timeoutMs);

    let streamChain: Promise<void> = Promise.resolve();
    const enqueueStream = (task: () => Promise<void>) => {
      streamChain = streamChain.then(task).catch(() => {});
    };

    const append = (chunk: string, stream: "out" | "err") => {
      if (stream === "out") {
        if (outBuf.length + chunk.length > maxBytes) {
          outBuf += chunk.slice(0, Math.max(0, maxBytes - outBuf.length));
          truncated = true;
        } else {
          outBuf += chunk;
        }
      } else {
        if (errBuf.length + chunk.length > maxBytes) {
          errBuf += chunk.slice(0, Math.max(0, maxBytes - errBuf.length));
          truncated = true;
        } else {
          errBuf += chunk;
        }
      }
      rollupBytes += chunk.length;
      rollupLines += (chunk.match(/\n/g) ?? []).length;
    };

    const pump = async (chunk: string, stream: "out" | "err") => {
      append(chunk, stream);
      if (rollupBytes >= BYTES_BEFORE_YIELD || rollupLines >= LINES_BEFORE_YIELD) {
        rollupBytes = 0;
        rollupLines = 0;
        await yieldEventLoop();
      }
    };

    child.stdout.on("data", (d: Buffer) => {
      enqueueStream(() => pump(d.toString("utf8"), "out"));
    });
    child.stderr.on("data", (d: Buffer) => {
      enqueueStream(() => pump(d.toString("utf8"), "err"));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        cmd: trimmed,
        exitCode: killed ? 124 : (code ?? 0),
        stdout: stripAnsi(outBuf),
        stderr: stripAnsi(errBuf) + (killed ? `\n[killed: timeout ${timeoutMs}ms]` : ""),
        truncated,
        durationMs: Date.now() - start,
      });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        cmd: trimmed,
        exitCode: 1,
        stdout: stripAnsi(outBuf),
        stderr: stripAnsi(errBuf) + `\n[spawn error: ${err.message}]`,
        truncated,
        durationMs: Date.now() - start,
      });
    });
  });
}
