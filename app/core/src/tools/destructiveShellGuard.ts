/**
 * Hard block recursive deletes via run_command — they bypass workspace sandbox
 * and caused real-world data loss (rd /s /q on Windows, rm -rf, Remove-Item).
 * Use deleteEntry / file-tree delete instead (safeJoin + guards).
 */
import path from "node:path";
import { getWorkspace } from "../utils/workspace.js";
import { rejectShellPathsOutsideWorkspace } from "../utils/pathSandbox.js";

const RECURSIVE_DELETE_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\brd\s+(\/s\s+)?\/q\b/i, label: "rd /s /q" },
  { re: /\brmdir\s+(\/s\s+)?\/q\b/i, label: "rmdir /s /q" },
  { re: /\bdel\s+\/f\s*\/s\s*\/q\b/i, label: "del /f /s /q" },
  { re: /\bdel\s+\/s\b/i, label: "del /s" },
  { re: /\berase\s+\/s\b/i, label: "erase /s" },
  { re: /\bRemove-Item\b[^\n;|&]*-Recurse/i, label: "Remove-Item -Recurse" },
  { re: /\brm\s+-[a-z]*f[a-z]*\b/i, label: "rm -rf" },
  { re: /\brm\s+-[a-z]*r[a-z]*\b/i, label: "rm -r" },
  { re: /\bformat\s+[A-Za-z]:\b/i, label: "format drive" },
  { re: /\bdiskpart\b/i, label: "diskpart" },
  { re: /\bcipher\s+\/w\b/i, label: "cipher /w" },
  { re: /\b(?:rd|rmdir|del)\s+[A-Za-z]:[\\/]/i, label: "recursive delete on drive path" },
];

/** Drive root or bare `D:` targets inside a delete command. */
const DRIVE_ROOT_TARGET =
  /\b(?:rd|rmdir|del)\s+(?:\/[a-z]+\s+)*\/q\s+("?)([A-Za-z]:)\\?\1\s*(?:$|[;&|])/i;

export function rejectDestructiveShellCommand(cmd: string): string | null {
  const trimmed = cmd.trim();
  if (!trimmed) return null;

  const outside = rejectShellPathsOutsideWorkspace(trimmed, getWorkspace());
  if (outside) return outside;

  for (const { re, label } of RECURSIVE_DELETE_PATTERNS) {
    if (re.test(trimmed)) {
      return (
        `Blocked dangerous shell command (${label}). ` +
        `Use delete_path with a single workspace-relative path ` +
        `(e.g. {"type":"delete_path","input":{"path":"old-folder"}}) — not rd/rmdir/Remove-Item in run_command.`
      );
    }
  }

  const rootHit = DRIVE_ROOT_TARGET.exec(trimmed);
  if (rootHit) {
    return `Blocked: cannot recursively delete drive root ${rootHit[2]}:\\ via shell.`;
  }

  // `rd /s /q ..` from a shallow cwd can wipe the parent folder (e.g. whole D:\).
  if (/\b(?:rd|rmdir)\s+(\/s\s+)?\/q\s+(\.\.(?:\\\.\.)*)\s*$/i.test(trimmed)) {
    const ws = path.resolve(getWorkspace());
    const parent = path.dirname(ws);
    if (path.resolve(parent) === path.parse(ws).root || parent.length <= 3) {
      return "Blocked: rd/rmdir on .. would target a drive root or parent of workspace.";
    }
    return (
      "Blocked: recursive delete via .. in shell. " +
      "Use delete_file on a workspace-relative path instead."
    );
  }

  return null;
}
