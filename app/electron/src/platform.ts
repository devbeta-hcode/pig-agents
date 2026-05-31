import path from "node:path";

export function isWindows(): boolean {
  return process.platform === "win32";
}

export function isMac(): boolean {
  return process.platform === "darwin";
}

export function isLinux(): boolean {
  return process.platform === "linux";
}

/** Default interactive shell for PTY (phase: terminal). */
export function defaultShell(): string {
  if (isWindows()) {
    return process.env.PIG_SHELL || "powershell.exe";
  }
  return process.env.SHELL || "/bin/bash";
}

export function displayPlatform(): string {
  if (isWindows()) return "windows";
  if (isMac()) return "macos";
  if (isLinux()) return "linux";
  return process.platform;
}

export function normalizePath(p: string): string {
  return path.normalize(p);
}
