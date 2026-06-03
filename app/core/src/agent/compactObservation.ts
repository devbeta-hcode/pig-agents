/**
 * Shrink tool results before sending back to the LLM (token budget).
 */

export function compactToolResultForLlm(toolName: string, summary: string): string {
  const s = summary.trim();
  if (!s) return s;

  switch (toolName) {
    case "run_command": {
      const cap = 2800;
      if (s.length <= cap) return s;
      return "…\n" + s.slice(-cap);
    }
    case "read_file":
      return s.length > 5500 ? s.slice(0, 5500) + "\n…(truncated for context)" : s;
    case "write_patch":
    case "create_file": {
      const lines = s.split("\n");
      const key = lines.filter(
        (l) =>
          /^(OK|FAIL) /i.test(l) ||
          l.startsWith("Validation:") ||
          /^\[WP_/.test(l),
      );
      if (key.length) return key.join("\n");
      return s.slice(0, 1200);
    }
    case "search_code":
    case "find_symbol":
    case "find_references":
    case "semantic_search":
    case "glob":
    case "list_files":
      return s.length > 3500 ? s.slice(0, 3500) + "\n…" : s;
    case "browser_get_text":
    case "browser_get_html":
      return s.slice(0, 4000);
    default:
      return s.length > 4500 ? s.slice(0, 4500) + "\n…" : s;
  }
}
