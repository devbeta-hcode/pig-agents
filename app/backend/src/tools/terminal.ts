import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { getWorkspace } from "../utils/workspace.js";
import { logger } from "../utils/logger.js";

export interface PtyLike {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(cb: (chunk: string) => void): void;
  onExit(cb: (info: { exitCode: number }) => void): void;
  kill(signal?: string): void;
}

export async function createPty(opts: { cols?: number; rows?: number; cwd?: string }): Promise<PtyLike> {
  const cwd = opts.cwd ?? getWorkspace();
  const cols = opts.cols ?? 100;
  const rows = opts.rows ?? 30;

  // 1. Prefer native node-pty (optional native build).
  try {
    const moduleName = "node-pty";
    const mod: any = await import(/* @vite-ignore */ moduleName);
    const shell = process.env.SHELL || "bash";
    const term = mod.spawn(shell, [], {
      name: "xterm-color",
      cols,
      rows,
      cwd,
      env: process.env as Record<string, string>,
    });
    const dataHandlers: ((c: string) => void)[] = [];
    const exitHandlers: ((info: { exitCode: number }) => void)[] = [];
    term.onData((d: string) => dataHandlers.forEach((cb) => cb(d)));
    term.onExit((e: { exitCode: number }) => exitHandlers.forEach((cb) => cb({ exitCode: e.exitCode })));

    logger.info("terminal: using node-pty");
    return {
      write: (d) => term.write(d),
      resize: (c, r) => { try { term.resize(c, r); } catch { /* noop */ } },
      onData: (cb) => { dataHandlers.push(cb); },
      onExit: (cb) => { exitHandlers.push(cb); },
      kill: (sig) => { try { term.kill(sig); } catch { /* noop */ } },
    };
  } catch (err) {
    logger.warn("node-pty unavailable:", (err as Error).message);
  }

  // 2. Fallback: use the `script` utility (util-linux) to allocate a real PTY without native code.
  if (hasScriptCommand()) {
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
    ...(process.env as Record<string, string>),
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
    kill: (sig) => { try { child.kill((sig as NodeJS.Signals) ?? "SIGTERM"); } catch { /* noop */ } },
  };
}

function createDumbShell(cwd: string): PtyLike {
  const child: ChildProcessWithoutNullStreams = spawn("bash", ["-i"], {
    cwd,
    env: { ...process.env, TERM: "dumb" },
  });
  const dataHandlers: ((c: string) => void)[] = [];
  const exitHandlers: ((info: { exitCode: number }) => void)[] = [];

  child.stdout.on("data", (b: Buffer) => dataHandlers.forEach((cb) => cb(b.toString("utf8"))));
  child.stderr.on("data", (b: Buffer) => dataHandlers.forEach((cb) => cb(b.toString("utf8"))));
  child.on("close", (code) => exitHandlers.forEach((cb) => cb({ exitCode: code ?? 0 })));

  return {
    write: (d) => { child.stdin.write(d); },
    resize: () => { /* unsupported */ },
    onData: (cb) => { dataHandlers.push(cb); },
    onExit: (cb) => { exitHandlers.push(cb); },
    kill: (sig) => { try { child.kill((sig as NodeJS.Signals) ?? "SIGTERM"); } catch { /* noop */ } },
  };
}
