/**
 * Detect run_command patterns that usually map to built-in agent tools.
 * We do not block these — only nudge the model to prefer tools when equivalent.
 */
export function preferAgentToolOverShellHint(cmd: string): string | null {
  const c = cmd.trim();
  if (!c) return null;

  const lower = c.toLowerCase();

  if (
    /^\s*(npm|npx|pnpm|yarn|bun)\s/i.test(c) ||
    /^\s*git\s/i.test(c) ||
    /^\s*(cargo|go|dotnet|msbuild|make)\s/i.test(c) ||
    /^\s*python\s+-m\s/i.test(c) ||
    /^\s*pytest\b/i.test(c) ||
    /^\s*docker\s/i.test(c)
  ) {
    return null;
  }

  const rules: Array<{ re: RegExp; hint: string }> = [
    {
      re: /\b(findstr|find\s+\/[inc]|grep\s+|rg\s+|ripgrep\s+|\bag\s+-)/i,
      hint: "search_code is usually simpler than shell search (findstr/grep/rg).",
    },
    {
      re: /\bnode\s+(?:--eval|-e|--print|-p)\b/i,
      hint: "read_file / search_code / find_symbol are safer than node -e for repo inspection.",
    },
    {
      re: /\b(?:type|more|less)\s+[\w./\\-]+\.\w+/i,
      hint: "read_file returns structured content; type/cat is fine when you need raw bytes.",
    },
    {
      re: /\b(?:cat|head|tail)\s+[\w./\\-]+\.\w+/i,
      hint: "read_file is preferred for source files; cat/head/tail OK for logs or pipelines.",
    },
    {
      re: /\bget-content\s+[\w./\\-]+/i,
      hint: "read_file is preferred; Get-Content is OK for one-off PowerShell workflows.",
    },
    {
      re: /\bselect-string\b/i,
      hint: "search_code is preferred; Select-String is OK when you need PowerShell-specific behavior.",
    },
    {
      re: /\bpowershell(?:\.exe)?\s+.*(?:get-content|select-string|findstr)/i,
      hint: "Prefer read_file / search_code unless PowerShell is clearly the right tool.",
    },
    {
      re: /\bstart(\s+""|\s+\/[\w]+)*\s+["']?[\w./\\-]+\.(html?|htm)\b/i,
      hint: "browser_navigate url=\"index.html\" opens the site in the embedded Browser tab; start/explorer often fails on Windows.",
    },
    {
      re: /\bcd\s+[\w./\\-]+\s*&&\s*(?:findstr|find\s|grep\s|rg\s|node\s+-e|node\s+--eval|type\s|cat\s|head\s|tail\s|powershell)/i,
      hint: "cwd is already workspace root — try search_code/read_file with paths like subdir/file.tsx before cd && shell.",
    },
    {
      re: /\bpython\s+-c\s+['"]/i,
      hint: "read_file / search_code are preferred; python -c is OK for quick scripting.",
    },
  ];

  for (const { re, hint } of rules) {
    if (re.test(lower) || re.test(c)) return hint;
  }

  return null;
}

/** @deprecated Use preferAgentToolOverShellHint */
export const shellProbeInsteadOfToolHint = preferAgentToolOverShellHint;
