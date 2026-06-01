/**
 * Detect shell commands that try to launch an external browser instead of the
 * embedded Browser panel — common model mistake when user says "open browser".
 */
export function externalBrowserLaunchHint(cmd: string): string | null {
  const c = cmd.trim().toLowerCase();
  if (!c) return null;

  const blocked: RegExp[] = [
    /\bstart\s+(chrome|msedge|microsoft-edge|edge|firefox|iexplore|brave|opera|vivaldi)\b/,
    /\b(chrome|msedge|firefox|brave|opera|iexplore)\.exe\b/,
    /\bstart\s+https?:\/\//,
    /\bstart\s+www\./,
    /\bexplorer\.exe\s+.*https?:\/\//,
    /\brundll32(\.exe)?\s+url\.dll\b/,
    /\b(open|xdg-open)\s+https?:\/\//,
    /\bopen\s+-a\s+(google chrome|safari|firefox)\b/,
  ];

  if (!blocked.some((re) => re.test(c))) return null;

  return (
    "Do NOT launch Chrome/Edge/Firefox via run_command. " +
    'Use browser_show (no input) or browser_navigate with url "about:blank" to open the embedded Browser tab in Pig Agents, ' +
    "then browser_navigate with a real URL to load a page."
  );
}
