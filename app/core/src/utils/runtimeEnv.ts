/**
 * Runtime host facts injected into agent context so models adapt run_command
 * syntax to the actual OS/shell — not hardcoded Windows or Linux assumptions.
 */
import { defaultShell, isWindows, shellCommandSpawn } from "./shell.js";

export type RunCommandShellKind = "powershell" | "bash" | "cmd" | "posix-sh" | "other";

export interface RunCommandShellInfo {
  os: string;
  platform: string;
  shellFile: string;
  shellKind: RunCommandShellKind;
  /** Human-readable invocation pattern (cmd placeholder). */
  invocation: string;
  pathSeparator: string;
  pigShellOverride: string | null;
  terminalDefaultShell: string;
}

function classifyShell(file: string): RunCommandShellKind {
  const base = file.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? file.toLowerCase();
  if (/powershell/.test(base)) return "powershell";
  if (base === "bash" || base === "sh" || base === "zsh") return /bash/.test(base) ? "bash" : "posix-sh";
  if (base === "cmd.exe" || base === "cmd") return "cmd";
  if (isWindows) return "other";
  return "posix-sh";
}

/** Describe how `run_command` spawns on this machine (mirrors shellCommandSpawn). */
export function describeRunCommandShell(): RunCommandShellInfo {
  const platform = process.platform;
  const os =
    platform === "win32" ? "windows" : platform === "darwin" ? "macos" : platform === "linux" ? "linux" : platform;
  const spec = shellCommandSpawn("echo");
  const shellKind = classifyShell(spec.file);
  const prefix = spec.args.slice(0, -1);
  const invocation =
    prefix.length > 0 ? `${spec.file} ${prefix.join(" ")} "<cmd>"` : `${spec.file} "<cmd>"`;

  return {
    os,
    platform,
    shellFile: spec.file,
    shellKind,
    invocation,
    pathSeparator: isWindows ? "\\" : "/",
    pigShellOverride: process.env.PIG_SHELL?.trim() || null,
    terminalDefaultShell: defaultShell(),
  };
}

function shellGuidance(kind: RunCommandShellKind): string[] {
  switch (kind) {
    case "cmd":
      return [
        "Use cmd.exe syntax: set VAR=value, %VAR%, && chains.",
        "Avoid bash-only: export, source, $(…), single-quoted env.",
      ];
    case "bash":
      return [
        "Git Bash / bash -lc: Unix-style paths and pipelines work.",
        "Quote Windows paths that contain spaces or backslashes.",
      ];
    case "powershell":
      return [
        "PowerShell: $env:VAR = \"value\", ; statement separator, Get-Content / Select-String.",
        "Avoid cmd-only %VAR% unless explicitly mixing shells.",
      ];
    case "posix-sh":
      return ["POSIX shell: export, &&, pipes, and / paths as usual."];
    default:
      return ["Match syntax to the shell named above."];
  }
}

function previewStaticSiteGuidance(info: RunCommandShellInfo): string[] {
  const lines = [
    "Preview static HTML in this app: browser_show → browser_navigate url=\"index.html\" (workspace-relative) — NOT run_command start/explorer.",
    "If you need a local server: python -m http.server 8000 (background) → browser_navigate http://localhost:8000/",
  ];
  if (info.os === "windows") {
    lines.push(
      "Windows: run_command uses cmd.exe or Git Bash — cmd-only `start \"\" file.html` often fails (Exit 1). Never use it for demo/preview.",
    );
  }
  return lines;
}

/** Block appended to agent user context every turn. */
export function buildRuntimeEnvBlock(): string {
  const info = describeRunCommandShell();
  const lines = [
    "RUNTIME ENV (actual host — adapt run_command to this; do not assume Linux or Windows blindly):",
    `- OS: ${info.os} (${info.platform})`,
    `- run_command: ${info.invocation}`,
    `- Shell kind: ${info.shellKind} (${info.shellFile})`,
    `- Path separator: ${info.pathSeparator}`,
    ...shellGuidance(info.shellKind).map((h) => `- ${h}`),
    ...previewStaticSiteGuidance(info).map((h) => `- ${h}`),
  ];
  if (info.pigShellOverride) {
    lines.push(`- PIG_SHELL override: ${info.pigShellOverride}`);
  }
  if (info.terminalDefaultShell !== info.shellFile) {
    lines.push(
      `- Embedded terminal panel uses: ${info.terminalDefaultShell} (may differ from run_command)`,
    );
  }
  return `\n${lines.join("\n")}\n`;
}
