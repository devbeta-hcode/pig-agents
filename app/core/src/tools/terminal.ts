import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { getWorkspace } from "../utils/workspace.js";
import { logger } from "../utils/logger.js";
import { defaultShell, isWindows, killShellProcess } from "../utils/shell.js";
import { childSpawnEnv } from "./smartCommand.js";

/** node-pty is CJS + a native .node addon; require() is reliable from ESM main. */
const requirePty = createRequire(import.meta.url);

interface NodePtyModule {
  spawn(file: string, args: string[] | string, options: Record<string, unknown>): {
    write(data: string): void;
    resize(cols: number, rows: number): void;
    onData(cb: (data: string) => void): void;
    onExit(cb: (e: { exitCode: number }) => void): void;
    kill(signal?: string): void;
  };
}

export interface PtyLike {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(cb: (chunk: string) => void): void;
  onExit(cb: (info: { exitCode: number }) => void): void;
  kill(signal?: string): void;
  /** Shell root PID when available (used to kill dev-server child trees on Windows). */
  pid?: number;
}

export async function createPty(opts: { cols?: number; rows?: number; cwd?: string }): Promise<PtyLike> {
  const cwd = opts.cwd ?? getWorkspace();
  const cols = opts.cols ?? 100;
  const rows = opts.rows ?? 30;

  // 1. Prefer native node-pty (ConPTY on Windows). Must be rebuilt for Electron:
  //    npm run rebuild:native
  try {
    const mod = requirePty("node-pty") as NodePtyModule;
    const shell = defaultShell();
    const term = mod.spawn(shell, [], {
      name: "xterm-color",
      cols,
      rows,
      cwd,
      env: childSpawnEnv() as Record<string, string>,
    });
    const dataHandlers: ((c: string) => void)[] = [];
    const exitHandlers: ((info: { exitCode: number }) => void)[] = [];
    term.onData((d: string) => dataHandlers.forEach((cb) => cb(d)));
    term.onExit((e: { exitCode: number }) => exitHandlers.forEach((cb) => cb({ exitCode: e.exitCode })));

    const pid = (term as { pid?: number }).pid;
    logger.info("terminal: using node-pty");
    return {
      write: (d) => term.write(d),
      resize: (c, r) => { try { term.resize(c, r); } catch { /* noop */ } },
      onData: (cb) => { dataHandlers.push(cb); },
      onExit: (cb) => { exitHandlers.push(cb); },
      pid,
      kill: (sig) => {
        if (pid) {
          killShellProcess({
            pid,
            kill: () => {
              try { term.kill(sig); return true; } catch { return false; }
            },
          }, "SIGKILL");
        }
        else {
          try { term.kill(sig); } catch { /* noop */ }
        }
      },
    };
  } catch (err) {
    logger.warn("node-pty unavailable:", (err as Error).message);
  }

  // 2. Fallback: use the `script` utility (util-linux) to allocate a real PTY without native code.
  //    (POSIX only — Windows has no `script`.)
  if (!isWindows && hasScriptCommand()) {
    logger.info("terminal: using `script` PTY fallback");
    return createScriptPty(cwd, cols, rows);
  }

  // 3. Last resort: dumb child_process pipe (no job control, no echo).
  logger.warn("terminal: using dumb child_process fallback (no PTY, no job control)");
  return createDumbShell(cwd);
}

function hasScriptCommand(): boolean {
  try {
    const r = spawnSync("script", ["--version"], { stdio: "ignore" });
    return r.status === 0;
  } catch { return false; }
}

/**
 * Allocates a real PTY by running bash inside `script -qfc "<shell> -i" /dev/null`.
 * `script` from util-linux opens a pseudo-tty internally and forwards I/O,
 * giving proper echo, line discipline and job control without native modules.
 */
function createScriptPty(cwd: string, cols: number, rows: number): PtyLike {
  const shell = process.env.SHELL || "/bin/bash";
  const env: Record<string, string> = {
    ...(childSpawnEnv() as Record<string, string>),
    TERM: "xterm-256color",
    COLUMNS: String(cols),
    LINES: String(rows),
    PS1: process.env.PS1 || "\\u@\\h:\\w$ ",
  };
  const child: ChildProcessWithoutNullStreams = spawn(
    "script",
    ["-qfc", `${shell} -i`, "/dev/null"],
    { cwd, env, stdio: ["pipe", "pipe", "pipe"] },
  );

  const dataHandlers: ((c: string) => void)[] = [];
  const exitHandlers: ((info: { exitCode: number }) => void)[] = [];

  child.stdout.on("data", (b: Buffer) => {
    const s = b.toString("utf8");
    dataHandlers.forEach((cb) => cb(s));
  });
  child.stderr.on("data", (b: Buffer) => {
    const s = b.toString("utf8");
    dataHandlers.forEach((cb) => cb(s));
  });
  child.on("exit", (code) => exitHandlers.forEach((cb) => cb({ exitCode: code ?? 0 })));
  child.on("error", (e) => {
    dataHandlers.forEach((cb) => cb(`\r\n[shell error] ${e.message}\r\n`));
  });

  const pid = child.pid;
  return {
    write: (d) => { try { child.stdin.write(d); } catch { /* noop */ } },
    resize: (c, r) => {
      // Best-effort resize hint without native ioctl.
      try {
        process.env.COLUMNS = String(c);
        process.env.LINES = String(r);
        child.kill("SIGWINCH");
      } catch { /* noop */ }
    },
    onData: (cb) => { dataHandlers.push(cb); },
    onExit: (cb) => { exitHandlers.push(cb); },
    pid,
    kill: (sig) => {
      if (pid) {
        killShellProcess({
          pid,
          kill: () => {
            try { return child.kill((sig as NodeJS.Signals) ?? "SIGTERM"); } catch { return false; }
          },
        }, "SIGKILL");
      } else {
        try { child.kill((sig as NodeJS.Signals) ?? "SIGTERM"); } catch { /* noop */ }
      }
    },
  };
}

function createDumbShell(cwd: string): PtyLike {
  const shell = defaultShell();
  // Interactive flags differ per shell. PowerShell/cmd don't take `-i`.
  const args = isWindows
    ? (/powershell/i.test(shell) ? ["-NoLogo"] : [])
    : ["-i"];

  const dataHandlers: ((c: string) => void)[] = [];
  const exitHandlers: ((info: { exitCode: number }) => void)[] = [];

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(shell, args, {
      cwd,
      env: { ...childSpawnEnv(), TERM: "dumb" },
    });
  } catch (err) {
    // Synchronous spawn failure — surface it to the terminal instead of crashing.
    const msg = (err as Error).message;
    return {
      write: () => { /* noop */ },
      resize: () => { /* noop */ },
      onData: (cb) => { setTimeout(() => cb(`\r\n[shell error] ${msg}\r\n`), 0); },
      onExit: (cb) => { setTimeout(() => cb({ exitCode: 1 }), 0); },
      kill: () => { /* noop */ },
    };
  }

  child.stdout.on("data", (b: Buffer) => dataHandlers.forEach((cb) => cb(b.toString("utf8"))));
  child.stderr.on("data", (b: Buffer) => dataHandlers.forEach((cb) => cb(b.toString("utf8"))));
  child.on("close", (code) => exitHandlers.forEach((cb) => cb({ exitCode: code ?? 0 })));
  // CRITICAL: without an 'error' handler an async spawn failure (e.g. ENOENT)
  // becomes an uncaught exception that crashes the Electron main process.
  child.on("error", (e) => {
    dataHandlers.forEach((cb) => cb(`\r\n[shell error] ${e.message}\r\n`));
    exitHandlers.forEach((cb) => cb({ exitCode: 1 }));
  });

  const pid = child.pid;
  return {
    write: (d) => { try { child.stdin.write(d); } catch { /* noop */ } },
    resize: () => { /* unsupported */ },
    onData: (cb) => { dataHandlers.push(cb); },
    onExit: (cb) => { exitHandlers.push(cb); },
    pid,
    kill: (sig) => {
      if (pid) {
        killShellProcess({
          pid,
          kill: () => {
            try { return child.kill((sig as NodeJS.Signals) ?? "SIGTERM"); } catch { return false; }
          },
        }, "SIGKILL");
      } else {
        try { child.kill((sig as NodeJS.Signals) ?? "SIGTERM"); } catch { /* noop */ }
      }
    },
  };
}
