/**
 * Windows-only helpers to release file locks before deleting project trees
 * (e.g. node_modules/esbuild.exe held by a running Vite dev server).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { isWindows } from "../utils/shell.js";

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  spawnSync("powershell.exe", ["-NoProfile", "-Command", `Start-Sleep -Milliseconds ${ms}`], {
    stdio: "ignore",
    timeout: ms + 5000,
  });
}

/**
 * Stop processes whose executable lives under `targetAbs` or whose command line
 * references that path (node/vite holding esbuild.exe, rollup .node files, etc.).
 */
export function windowsReleasePathLocks(targetAbs: string): number {
  if (!isWindows) return 0;
  const target = path.resolve(targetAbs);
  const escaped = target.replace(/'/g, "''");

  const script = `
$t = [System.IO.Path]::GetFullPath('${escaped}')
$n = 0
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object {
  $exe = $_.ExecutablePath
  $cmd = $_.CommandLine
  $hit = $false
  if ($exe -and $exe.StartsWith($t, [System.StringComparison]::OrdinalIgnoreCase)) { $hit = $true }
  if (-not $hit -and $cmd -and ($cmd -like ('*' + $t + '*'))) { $hit = $true }
  if ($hit) {
    try {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop
      $n++
    } catch {}
  }
}
$n
`.trim();

  const r = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { encoding: "utf8", timeout: 60_000 },
  );

  let killed = 0;
  if (r.status === 0 && r.stdout?.trim()) {
    const n = parseInt(r.stdout.trim(), 10);
    if (Number.isFinite(n)) killed = n;
  }

  if (killed > 0) sleepSync(600);
  return killed;
}

/** Clear read-only attrs so rd / fs.rm can remove git/npm trees on Windows. */
export function windowsClearAttributesRecursive(targetAbs: string): void {
  if (!isWindows) return;
  const quoted = `"${path.resolve(targetAbs).replace(/"/g, '""')}"`;
  spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `attrib -r ${quoted}\\* /s /d`], {
    stdio: "ignore",
    timeout: 120_000,
  });
}
