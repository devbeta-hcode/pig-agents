import { spawn, spawnSync, ChildProcess } from "node:child_process";
import { getWorkspace } from "../utils/workspace.js";
import { isWindows, killShellProcess, prepareAgentCommand, shellCommandSpawn } from "../utils/shell.js";

/**
 * Build the env object passed to spawned child processes. We strip the agent
 * server's own port-related vars so a `node`/`next`/`nest`/`vite` invocation
 * inside a workspace defaults to its own port (e.g. `process.env.PORT || 3001`)
 * instead of inheriting the agent's listen port — that bug had user dev
 * servers booting on the agent's port and stealing all HTTP traffic.
 */
export function childSpawnEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.PORT;
  delete env.BACKEND_PORT;
  delete env.AGENT_PORT;
  // Piped stdio is not a TTY — Python (and some other tools) block-buffer without this.
  if (!env.PYTHONUNBUFFERED) env.PYTHONUNBUFFERED = "1";
  if (process.platform === "win32" && !env.PYTHONIOENCODING) env.PYTHONIOENCODING = "utf-8";
  // Piped stdio: many CLIs (npm, pytest, etc.) flush line-by-line when CI is set.
  if (!env.CI) env.CI = "1";
  return env;
}

/** Lets other HTTP handlers / timers run — avoids starving the event loop on huge stdout/stderr. */
function yieldEventLoop(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

/** Roughly ~40KB or many lines before yielding (whichever hits first). */
const BYTES_BEFORE_YIELD = 40 * 1024;
const LINES_BEFORE_YIELD = 96;

/**
 * Smart command execution for modern agent behavior.
 * Detects long-running processes (dev servers, watchers) and handles them
 * intelligently - returning early when the server is ready or after a short
 * initial period, while the process continues in the background.
 */

// Strip ANSI escape codes from output
const ANSI_REGEX = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
function stripAnsi(str: string): string {
  return str.replace(ANSI_REGEX, "");
}

// ============================================================================
// Patterns to detect long-running / dev server commands
// ============================================================================

const LONG_RUNNING_PATTERNS = [
  // npm/yarn/pnpm dev servers
  /\b(npm|yarn|pnpm)\s+(run\s+)?(dev|start|serve|watch|preview)\b/i,
  /\bnpx\s+(vite|next|nuxt|remix|astro|serve|http-server)\b/i,
  /\b(vite|next|nuxt|remix|astro|webpack|parcel)\s*(dev|start|serve)?\b/i,
  
  // Python servers
  /\bpython\s+.*\b(runserver|manage\.py|flask|uvicorn|gunicorn|http\.server)\b/i,
  /\buvicorn\b/i,
  /\bgunicorn\b/i,
  /\bflask\s+run\b/i,
  /\bdjango.*runserver\b/i,
  
  // Other common dev servers
  /\bphp\s+.*-S\b/i,  // php -S localhost:8000
  /\bruby\s+.*rails\s+s(erver)?\b/i,
  /\bcargo\s+(run|watch)\b/i,
  /\bgo\s+run\b.*--?\s*(watch|serve)/i,
  /\bdeno\s+(run|task).*(dev|start|serve)/i,
  
  // Watch/hot-reload tools
  /\b(nodemon|ts-node-dev|tsx\s+watch|tsc\s+--watch|jest\s+--watch)\b/i,
  /\btailwindcss\b.*--watch\b/i,
  
  // Docker
  /\bdocker(-compose)?\s+(up|run)\b/i,
];

// ============================================================================
// Patterns to detect when a server/process is "ready"
// ============================================================================

const READY_PATTERNS = [
  // Common port/URL messages
  /\b(listening|running|started|ready|live|serving)\b.*\b(on|at)\s*(port|:)?\s*\d+/i,
  /\blocal(host)?:\s*https?:\/\/[^\s]+/i,
  /https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?/i,
  /\bport\s+\d+\b/i,
  
  // Framework-specific ready messages
  /\bready\s+in\s+\d+/i,                     // Vite: "ready in 300ms"
  /\bcompiled\s+(successfully|client)/i,     // Next.js, webpack
  /\bwaiting\s+for\s+changes/i,              // tsc --watch
  /\bwatching\s+for\s+file\s+changes/i,      // many watchers
  /\bserver\s+started\b/i,
  /\bdevelopment\s+server\b/i,
  /\bdev\s+server\b/i,
  /\bstarting\s+.*server/i,
  /\bpress\s+.*to\s+(quit|exit|stop)/i,      // Flask, Django hints
  /\bApp\s+running\b/i,
  /\bApplication\s+startup\s+complete/i,     // Uvicorn
  /\bSPA\s+available\s+at/i,

  // Python http.server / dev servers (often on stderr)
  /\bServing HTTP on\b/i,
  /\bServing at\b/i,
  /\bPress CTRL\+C to quit\b/i,
  
  // Build success that implies watch mode continues
  /\bbuild\s+succeeded\b/i,
  /\bno\s+errors\s+found\b/i,
];

// ============================================================================
// Patterns to detect immediate failures
// ============================================================================

const FAILURE_PATTERNS = [
  /\b(error|fatal|failed|cannot|unable)\b.*\b(start|listen|bind|connect|find|load|resolve)\b/i,
  /\bEADDRINUSE\b/i,                         // Port already in use
  /\bENOENT\b/i,                             // File not found
  /\bcommand\s+not\s+found\b/i,
  /\bmodule\s+not\s+found\b/i,
  /\bsyntax\s*error\b/i,
  /\btype\s*error\b/i,
  /\breference\s*error\b/i,
  /\bpermission\s+denied\b/i,
  /\bnpm\s+err!\b/i,
  /\berror:\s+could\s+not/i,
  /\bexited\s+with\s+(code|status)\s+[1-9]/i,
  /\bcrash(ed)?\b/i,
];

// ============================================================================
// Types
// ============================================================================

export interface SmartCommandResult {
  cmd: string;
  mode: "completed" | "background" | "failed" | "timeout";
  exitCode: number | null;  // null if still running
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
  readySignal?: string;     // The line that triggered "ready" detection
  pid?: number;             // PID if running in background
  hint?: string;            // Helpful hint for the agent
}

export interface SmartCommandOptions {
  cwd?: string;
  /** Override timeouts: non-install finite wall (default 10m); install optional wall if set. */
  timeoutMs?: number;
  /** Max wait for dev-server "ready" lines before treating process as background (default 45s). */
  readyTimeoutMs?: number;
  /** Max output bytes to capture (default: 256KB) */
  maxBytes?: number;
  /** Force treat as long-running even if not detected */
  forceLongRunning?: boolean;
  /**
   * Called for each stdout/stderr chunk from the child (Node `data` events — already async).
   * Used to forward `command_chunk` to the UI without blocking the agent on a poll loop.
   */
  onStreamChunk?: (stream: "out" | "err", text: string) => void | Promise<void>;
  /**
   * Called immediately after the child process spawns with its PID.
   * Lets callers register the pid for cleanup before the command resolves
   * (important for long-running "background" commands where the promise may
   * resolve early and the caller needs to be able to kill the process later).
   */
  onChildSpawn?: (pid: number) => void;
}

// Keep track of background processes so we can clean them up
const backgroundProcesses = new Map<number, ChildProcess>();

// ============================================================================
// Main function
// ============================================================================

export function isLongRunningCommand(cmd: string): boolean {
  return LONG_RUNNING_PATTERNS.some(pattern => pattern.test(cmd));
}

/**
 * Long installs across ecosystems (Node, Python, Rust, …): no dumb wall-clock kill by default;
 * same idle-stall logic for all. Not Node-only.
 */
export function isInstallLikeCommand(cmd: string): boolean {
  const c = cmd.trim();
  // JS / Node
  if (/\b(npm|yarn|pnpm|bun)\s+(install|ci|add|remove|update|dedupe|rebuild)\b/i.test(c)) return true;
  if (/\b(npm|yarn|pnpm)\s+create\b/i.test(c)) return true;
  if (/\bnpx\s+(-y|--yes)\s+/i.test(c)) return true;
  if (/\bnpx\s+create/i.test(c)) return true;
  if (/\bpnpm\s+dlx\b/i.test(c)) return true;
  // Python — pip, python -m pip, uv, pipx (common spellings)
  if (/\bpip3?\s+(install|download)\b/i.test(c)) return true;
  if (/\bpython3?(?:\.\d+)?\s+-m\s+pip\s+(install|download)\b/i.test(c)) return true;
  if (/\buv\s+(sync|pip\s+install)\b/i.test(c)) return true;
  if (/\bpipx\s+(install|inject)\b/i.test(c)) return true;
  if (/\bpoetry\s+(install|update)\b/i.test(c)) return true;
  if (/\bconda\s+(install|create)\b/i.test(c)) return true;
  if (/\bapt(-get)?\s+install\b/i.test(c)) return true;
  if (/\bcargo\s+(build|fetch|install)\b/i.test(c)) return true;
  if (/\bcomposer\s+(install|update)\b/i.test(c)) return true;
  if (/\bdocker\s+(build|pull)\b/i.test(c)) return true;
  if (/\bgo\s+mod\s+(download|verify)\b/i.test(c)) return true;
  // Ruby (often missed if we only listed npm)
  if (/\bbundle\s+install\b/i.test(c)) return true;
  if (/\bgem\s+install\b/i.test(c)) return true;
  return false;
}

/** Max wall-clock wait for typical finite commands (tests, builds). Use AGENT_RUN_COMMAND_TIMEOUT_MS=0 to wait until exit only. */
const DEFAULT_FINITE_TIMEOUT_MS = 600_000; // 10 min
/** Dev server: wait for READY_PATTERNS before returning "background". */
const DEFAULT_READY_TIMEOUT_MS = 12_000;
/** If no ready line yet, assume background once the process is still alive this long. */
const DEFAULT_ALIVE_FALLBACK_MS_WIN = 3000;
const DEFAULT_ALIVE_FALLBACK_MS = 5000;

/**
 * Install/scaffold commands: wall-clock timeouts cause bogus failures + model retry loops.
 * Default = wait until the process exits; only kill if **no stdout/stderr for a long time** (stuck registry/network).
 */
function installIdleKillMs(): number {
  const n = Number(process.env.AGENT_INSTALL_IDLE_TIMEOUT_MS);
  if (n === 0) return Infinity;
  if (Number.isFinite(n) && n >= 60_000) return Math.min(Math.floor(n), 86_400_000);
  return 900_000; // 15 min without a single byte → likely hung
}

function finiteWallTimeoutMs(): number {
  const envAll = Number(process.env.AGENT_RUN_COMMAND_TIMEOUT_MS);
  if (envAll === 0) return Infinity;
  if (Number.isFinite(envAll) && envAll >= 5000) return Math.min(Math.floor(envAll), 86_400_000);
  return DEFAULT_FINITE_TIMEOUT_MS;
}

export async function runSmartCommand(
  cmd: string,
  opts: SmartCommandOptions = {}
): Promise<SmartCommandResult> {
  const trimmed = prepareAgentCommand(cmd);
  if (!trimmed) throw new Error("Empty command");

  const streamCb = opts.onStreamChunk;
  const spawnCb = opts.onChildSpawn;
  const cwd = opts.cwd ?? getWorkspace();
  const maxBytes = opts.maxBytes ?? 256 * 1024;
  let isLongRunning = opts.forceLongRunning || isLongRunningCommand(trimmed);
  const installLike = isInstallLikeCommand(trimmed);

  const readyTimeoutMs =
    opts.readyTimeoutMs ??
    (Number(process.env.AGENT_DEV_SERVER_READY_TIMEOUT_MS) >= 5000
      ? Math.floor(Number(process.env.AGENT_DEV_SERVER_READY_TIMEOUT_MS))
      : DEFAULT_READY_TIMEOUT_MS);

  /** Optional hard ceiling for installs only (default: none — rely on idle stall + process exit). */
  let installMaxWallMs: number | undefined = opts.timeoutMs;
  if (installMaxWallMs === undefined && installLike) {
    const cap = Number(process.env.AGENT_INSTALL_COMMAND_TIMEOUT_MS);
    if (Number.isFinite(cap) && cap >= 60_000) installMaxWallMs = Math.min(Math.floor(cap), 86_400_000);
  }

  const finiteWallMs = opts.timeoutMs ?? finiteWallTimeoutMs();
  const idleInstallMs = installIdleKillMs();
  
  const shell = shellCommandSpawn(trimmed);

  return new Promise<SmartCommandResult>((resolve) => {
    const start = Date.now();
    const child = spawn(shell.file, shell.args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: childSpawnEnv({
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        GIT_PAGER: "cat",
        PAGER: "cat",
      }),
      ...(shell.killAsGroup ? { detached: true } : {}),
    });

    // Notify caller of the PID as soon as the child is alive so they can
    // register it for potential early-kill (e.g. user dismisses the run).
    if (child.pid !== undefined && spawnCb) {
      try { spawnCb(child.pid); } catch { /* caller must not throw */ }
    }

    let outBuf = "";
    let errBuf = "";
    let truncated = false;
    let resolved = false;
    let readySignal: string | undefined;
    let rollupBytes = 0;
    let rollupLines = 0;
    let wallTimer: ReturnType<typeof setTimeout> | undefined;
    let aliveTimer: ReturnType<typeof setTimeout> | undefined;
    let idleWatch: ReturnType<typeof setInterval> | undefined;
    let childExited = false;
    let lastOutputAt = Date.now();

    const doResolve = (result: SmartCommandResult) => {
      if (resolved) return;
      resolved = true;
      if (wallTimer !== undefined) clearTimeout(wallTimer);
      if (aliveTimer !== undefined) clearTimeout(aliveTimer);
      if (idleWatch !== undefined) clearInterval(idleWatch);
      // Strip ANSI codes from output
      resolve({
        ...result,
        stdout: stripAnsi(result.stdout),
        stderr: stripAnsi(result.stderr),
        readySignal: result.readySignal ? stripAnsi(result.readySignal) : undefined,
      });
    };

    const scanCombined = () => {
      if (resolved) return;
      const combined = outBuf + errBuf;

      // npm/pip emit scary stderr during normal installs; don't SIGKILL mid-install.
      if (!installLike) {
        for (const pattern of FAILURE_PATTERNS) {
          const match = combined.match(pattern);
          if (match) {
            setTimeout(() => {
              if (!resolved) {
                doResolve({
                  cmd: trimmed,
                  mode: "failed",
                  exitCode: null,
                  stdout: outBuf,
                  stderr: errBuf,
                  truncated,
                  durationMs: Date.now() - start,
                  hint: `Command appears to have failed: "${match[0]}". Check the error output above.`,
                });
                killShellProcess(child, "SIGKILL");
              }
            }, 500);
            return;
          }
        }
      }

      // Auto-detect ANY custom command as a server if it explicitly outputs a listening URL/port
      if (!isLongRunning) {
        const SERVER_PATTERNS = [
          /\b(listening|running|started|ready|live|serving)\b.*\b(on|at)\s*(port|:)?\s*\d+/i,
          /\blocal(host)?:\s*https?:\/\/[^\s]+/i,
          /https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?/i,
        ];
        for (const pattern of SERVER_PATTERNS) {
          if (combined.match(pattern)) {
            isLongRunning = true;
            break;
          }
        }
      }

      if (isLongRunning) {
        for (const pattern of READY_PATTERNS) {
          const match = combined.match(pattern);
          if (match) {
            readySignal = match[0];
            if (child.pid) {
              backgroundProcesses.set(child.pid, child);
            }
            doResolve({
              cmd: trimmed,
              mode: "background",
              exitCode: null,
              stdout: outBuf,
              stderr: errBuf,
              truncated,
              durationMs: Date.now() - start,
              readySignal,
              pid: child.pid,
              hint: `Server is running in background (PID: ${child.pid}). Output so far indicates it started successfully: "${readySignal}". You can continue with other tasks.`,
            });
            return;
          }
        }
      }
    };

    const appendChunk = (chunk: string, stream: "out" | "err") => {
      lastOutputAt = Date.now();
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

    let streamChain: Promise<void> = Promise.resolve();
    const enqueueStream = (task: () => Promise<void>) => {
      streamChain = streamChain.then(task).catch(() => {});
    };

    const pumpChunk = async (chunk: string, stream: "out" | "err") => {
      if (resolved) return;
      appendChunk(chunk, stream);
      if (streamCb) {
        try {
          await Promise.resolve(streamCb(stream, chunk));
        } catch {
          /* stream consumer must not break the shell */
        }
      }
      scanCombined();
      if (rollupBytes >= BYTES_BEFORE_YIELD || rollupLines >= LINES_BEFORE_YIELD) {
        rollupBytes = 0;
        rollupLines = 0;
        await yieldEventLoop();
      }
    };

    child.stdout.on("data", (d: Buffer) => {
      enqueueStream(() => pumpChunk(d.toString("utf8"), "out"));
    });

    child.stderr.on("data", (d: Buffer) => {
      enqueueStream(() => pumpChunk(d.toString("utf8"), "err"));
    });

    child.on("close", (code) => {
      childExited = true;
      if (child.pid) {
        backgroundProcesses.delete(child.pid);
      }
      doResolve({
        cmd: trimmed,
        mode: "completed",
        exitCode: code ?? 0,
        stdout: outBuf,
        stderr: errBuf,
        truncated,
        durationMs: Date.now() - start,
      });
    });

    child.on("error", (err) => {
      if (child.pid) {
        backgroundProcesses.delete(child.pid);
      }
      doResolve({
        cmd: trimmed,
        mode: "failed",
        exitCode: 1,
        stdout: outBuf,
        stderr: errBuf + `\n[spawn error: ${err.message}]`,
        truncated,
        durationMs: Date.now() - start,
        hint: `Failed to start command: ${err.message}`,
      });
    });

    type KillReason = "stall-no-output" | "wall" | "max-wall";

    const killReasonWall = (ms: number, label: KillReason) => {
      killShellProcess(child, "SIGKILL");
      let hint: string;
      if (label === "stall-no-output") {
        hint =
          `No terminal output for ${Math.round(ms / 60_000)} min (install/scaffold). ` +
          `Registry/network may be hung. Tune AGENT_INSTALL_IDLE_TIMEOUT_MS (milliseconds; set 0 to disable idle kill only). ` +
          `ANTI_LOOP: Do not repeat the same install command next turn — verify package.json, lockfile, and partial node_modules first.`;
      } else if (label === "max-wall") {
        hint =
          `Optional install wall (${ms / 1000}s) hit. Unset AGENT_INSTALL_COMMAND_TIMEOUT_MS to rely on idle + exit only, or raise the cap.`;
      } else {
        hint =
          `Wall-clock limit (${ms / 1000}s). Set AGENT_RUN_COMMAND_TIMEOUT_MS=0 on the server to wait until the process exits (no kill). ` +
          `ANTI_LOOP: Do not re-run the identical command without checking whether partial output succeeded.`;
      }
      doResolve({
        cmd: trimmed,
        mode: "timeout",
        exitCode: 124,
        stdout: outBuf,
        stderr: errBuf + `\n[timeout: ${label} ${ms}ms]`,
        truncated,
        durationMs: Date.now() - start,
        hint,
      });
    };

    if (isLongRunning) {
      const aliveEnv = Number(process.env.AGENT_DEV_SERVER_ALIVE_MS);
      const aliveFallbackMs = Math.min(
        readyTimeoutMs,
        Number.isFinite(aliveEnv) && aliveEnv >= 1000
          ? Math.floor(aliveEnv)
          : isWindows
            ? DEFAULT_ALIVE_FALLBACK_MS_WIN
            : DEFAULT_ALIVE_FALLBACK_MS,
      );

      aliveTimer = setTimeout(() => {
        if (resolved || childExited) return;
        if (child.pid) backgroundProcesses.set(child.pid, child);
        const combined = (outBuf + errBuf).trim();
        doResolve({
          cmd: trimmed,
          mode: "background",
          exitCode: null,
          stdout: outBuf,
          stderr: errBuf,
          truncated,
          durationMs: Date.now() - start,
          readySignal: readySignal ?? combined.split(/\r?\n/).filter(Boolean).pop(),
          pid: child.pid,
          hint:
            `Long-running process still alive after ${aliveFallbackMs}ms (PID: ${child.pid}). ` +
            `Treated as background — continue with the next step (curl/browser/etc.).`,
        });
      }, aliveFallbackMs);

      wallTimer = setTimeout(() => {
        if (resolved) return;
        if (child.pid) {
          backgroundProcesses.set(child.pid, child);
        }
        doResolve({
          cmd: trimmed,
          mode: "background",
          exitCode: null,
          stdout: outBuf,
          stderr: errBuf,
          truncated,
          durationMs: Date.now() - start,
          pid: child.pid,
          hint: `Long-running process started (PID: ${child.pid}). No explicit ready signal detected within ${readyTimeoutMs / 1000}s, but the process is still running. Check output for any issues. You can continue with other tasks.`,
        });
      }, readyTimeoutMs);
    } else if (installLike) {
      if (Number.isFinite(idleInstallMs) && idleInstallMs < Infinity) {
        idleWatch = setInterval(() => {
          if (resolved) return;
          if (Date.now() - lastOutputAt >= idleInstallMs) {
            killReasonWall(idleInstallMs, "stall-no-output");
          }
        }, 15_000);
      }
      if (installMaxWallMs !== undefined && Number.isFinite(installMaxWallMs)) {
        wallTimer = setTimeout(() => {
          if (resolved) return;
          killReasonWall(installMaxWallMs, "max-wall");
        }, installMaxWallMs);
      }
    } else if (Number.isFinite(finiteWallMs) && finiteWallMs < Infinity) {
      wallTimer = setTimeout(() => {
        if (resolved) return;
        killReasonWall(finiteWallMs, "wall");
      }, finiteWallMs);
    }
  });
}

function tryKill(child: ChildProcess) {
  killShellProcess(child, "SIGKILL");
}

/**
 * Kill a background process by PID
 */
export function killBackgroundProcess(pid: number): boolean {
  const child = backgroundProcesses.get(pid);
  if (child) {
    tryKill(child);
    backgroundProcesses.delete(pid);
    return true;
  }
  // Try to kill even if we don't have a reference
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, "SIGKILL");
    return true;
  } catch {
    return false;
  }
}

/**
 * Get list of tracked background processes
 */
export function listBackgroundProcesses(): number[] {
  return Array.from(backgroundProcesses.keys());
}

/**
 * Clean up all background processes (for shutdown)
 */
export function cleanupAllBackgroundProcesses(): void {
  for (const [pid, child] of backgroundProcesses) {
    tryKill(child);
    backgroundProcesses.delete(pid);
  }
}
