import type { SmartCommandResult } from "./smartCommand.js";

/** Windows `start` / `explorer` URL openers — exit code is often 1 even when the browser opened. */
export function isWindowsOpenerCommand(cmd: string): boolean {
  const c = cmd.trim();
  return (
    /^\s*start(\s+\/\w+)*\s+(https?:\/\/|www\.|[A-Za-z]:\\)/i.test(c) ||
    /^\s*start(\s+""|\s+\/[\w]+)*\s+["']?[\w./\\-]+\.(html?|htm)\b/i.test(c) ||
    /^\s*start\s+["']?[\w./\\-]+\.(html?|htm)\b/i.test(c) ||
    /^\s*explorer(\.exe)?\s+(https?:\/\/|[A-Za-z]:\\|[\w./\\-]+\.(html?|htm))/i.test(c) ||
    /^\s*cmd(\.exe)?\s+\/c\s+start\s+/i.test(c)
  );
}

export function runCommandSucceeded(r: SmartCommandResult, cmd: string): boolean {
  if (r.mode === "background") return true;
  if (r.mode === "failed" || r.mode === "timeout") return false;
  if (r.mode !== "completed") return false;
  if (r.exitCode === 0) return true;
  if (isWindowsOpenerCommand(cmd) && (r.exitCode === 0 || r.exitCode === 1)) {
    const combined = `${r.stdout}\n${r.stderr}`.toLowerCase();
    if (/command not found|is not recognized|cannot find|access is denied|blocked:/i.test(combined)) {
      return false;
    }
    return true;
  }
  return false;
}
