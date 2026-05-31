import { spawnSync, type ChildProcess } from "node:child_process";

export const isWindows = process.platform === "win32";

/** Interactive shell for PTY sessions (terminal panel). */
export function defaultShell(): string {
  if (isWindows) return process.env.PIG_SHELL || "powershell.exe";
  return process.env.SHELL || "/bin/bash";
}

export interface ShellSpawnSpec {
  file: string;
  args: string[];
  /** POSIX: kill process group via detached shell. Windows: use killShellProcess. */
  killAsGroup: boolean;
}

let cachedBashPath: string | null | undefined;

function findBashOnWindows(): string | null {
  if (cachedBashPath !== undefined) return cachedBashPath;
  try {
    const r = spawnSync("where", ["bash"], { encoding: "utf8", timeout: 3000 });
    if (r.status === 0 && r.stdout.trim()) {
      const first = r.stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
      cachedBashPath = first ?? null;
      return cachedBashPath;
    }
  } catch { /* noop */ }
  cachedBashPath = null;
  return null;
}

/** Ensure Python child processes flush lines immediately when stdout/stderr are pipes. */
export function prepareAgentCommand(cmd: string): string {
  const c = cmd.trim();
  if (!/\bpython(\d*(?:\.\d+)?)?\b/i.test(c) || /\s-u(\s|$)/i.test(c)) return c;
  return c.replace(/\bpython(\d*(?:\.\d+)?)?\b/gi, (m) => `${m} -u`);
}

/**
 * Spawn spec for one-shot agent commands (`run_command`, validation, …).
 * Unix: `$SHELL -lc "<cmd>"`. Windows: cmd.exe (or Git Bash / PIG_SHELL override).
 */
export function shellCommandSpawn(command: string): ShellSpawnSpec {
  const trimmed = command.trim();
  if (!isWindows) {
    return {
      file: process.env.SHELL || "/bin/bash",
      args: ["-lc", trimmed],
      killAsGroup: true,
    };
  }

  const override = process.env.PIG_SHELL?.trim();
  if (override) {
    if (/bash/i.test(override)) {
      return { file: override, args: ["-lc", trimmed], killAsGroup: false };
    }
    if (/powershell/i.test(override)) {
      return {
        file: override,
        args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", trimmed],
        killAsGroup: false,
      };
    }
    return { file: override, args: ["/d", "/s", "/c", trimmed], killAsGroup: false };
  }

  const gitBash = findBashOnWindows();
  if (gitBash) {
    return { file: gitBash, args: ["-lc", trimmed], killAsGroup: false };
  }

  return {
    file: process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", trimmed],
    killAsGroup: false,
  };
}

/** Kill shell and child processes (timeout / user cancel). */
export function killShellProcess(
  child: Pick<ChildProcess, "pid" | "kill">,
  signal: NodeJS.Signals = "SIGKILL",
): void {
  if (!child.pid) {
    try { child.kill(signal); } catch { /* noop */ }
    return;
  }
  if (isWindows) {
    try {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      try { child.kill(signal); } catch { /* noop */ }
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* noop */ }
  }
}
