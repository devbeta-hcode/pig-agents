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
 * Stop processes whose executable lives under `targetAbs`, whose command line
 * references that path (incl. 8.3 short paths), or whose cmd references the
 * folder leaf as a path segment (npm/vite started from a parent shell cwd).
 */
export function windowsReleasePathLocks(targetAbs: string): number {
  if (!isWindows) return 0;
  const target = path.resolve(targetAbs).replace(/[\\/]+$/, "");
  const escaped = target.replace(/'/g, "''");
  const leaf = path.basename(target).replace(/'/g, "''");

  const script = `
$t = [System.IO.Path]::GetFullPath('${escaped}')
$leaf = '${leaf}'
$short = $null
try {
  $fso = New-Object -ComObject Scripting.FileSystemObject
  $short = $fso.GetFolder($t).ShortPath
} catch {}

function Test-Hit($exe, $cmd) {
  foreach ($base in @($t, $short)) {
    if (-not $base) { continue }
    if ($exe -and $exe.StartsWith($base, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
    if ($cmd -and ($cmd.IndexOf($base, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)) { return $true }
  }
  if ($cmd -and $leaf -and ($leaf.Length -ge 2)) {
    $seg = [regex]::Escape($leaf)
    if ($cmd -match ('[\\\\/]' + $seg + '([\\\\/]|\\s|"|''|$)')) { return $true }
  }
  return $false
}

$pids = [System.Collections.Generic.HashSet[int]]::new()
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object {
  if (Test-Hit $_.ExecutablePath $_.CommandLine) {
    [void]$pids.Add([int]$_.ProcessId)
  }
}
Get-Process -ErrorAction SilentlyContinue | Where-Object {
  $_.Path -and ($_.Path.StartsWith($t, [System.StringComparison]::OrdinalIgnoreCase))
} | ForEach-Object { [void]$pids.Add($_.Id) }

$n = 0
foreach ($pid in $pids) {
  & taskkill.exe /PID $pid /T /F 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { $n++ }
}
$n
`.trim();

  const r = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { encoding: "utf8", timeout: 90_000 },
  );

  let killed = 0;
  if (r.stdout?.trim()) {
    const n = parseInt(r.stdout.trim().split(/\r?\n/).pop() ?? "", 10);
    if (Number.isFinite(n)) killed = n;
  }

  if (killed > 0) sleepSync(800);
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
