/**
 * Windows-only helpers to release file locks before deleting project trees
 * (e.g. node_modules/esbuild.exe held by a running Vite dev server).
 *
 * Does NOT delete files — only taskkill (scoped) and attrib -r. Actual removal
 * is fs.rm / rd in file.ts with paths from safeJoin(workspace).
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

/** Refuse drive roots and paths too shallow for safe lock release. */
export function assertSafeDeleteTarget(targetAbs: string): void {
  const target = path.resolve(targetAbs).replace(/[\\/]+$/, "");
  const parsed = path.parse(target);
  if (!parsed.root) {
    throw new Error(`Refusing unsafe delete target: ${target}`);
  }
  const rel = target.slice(parsed.root.length).replace(/^[\\/]+/, "");
  const depth = rel.split(/[\\/]/).filter(Boolean).length;
  if (depth < 1) {
    throw new Error(`Refusing delete or lock release on drive root: ${target}`);
  }
}

/** Leaf-name taskkill is only for deep, specific folders (avoids killing every \\TrainAI\\ process on D:). */
function allowLeafCommandLineMatch(targetAbs: string): boolean {
  const target = path.resolve(targetAbs);
  const parsed = path.parse(target);
  const relParts = target
    .slice(parsed.root.length)
    .replace(/^[\\/]+/, "")
    .split(/[\\/]/)
    .filter(Boolean);
  const leaf = path.basename(target);
  return relParts.length >= 2 && leaf.length >= 8;
}

/**
 * Stop processes whose executable lives under `targetAbs` or whose command line
 * contains that full path (incl. 8.3). Optional leaf segment match only for
 * deep paths with a long folder name.
 */
export function windowsReleasePathLocks(targetAbs: string): number {
  if (!isWindows) return 0;
  assertSafeDeleteTarget(targetAbs);
  const target = path.resolve(targetAbs).replace(/[\\/]+$/, "");
  const escaped = target.replace(/'/g, "''");
  const leaf = path.basename(target).replace(/'/g, "''");
  const useLeaf = allowLeafCommandLineMatch(targetAbs);

  const leafBlock = useLeaf
    ? `
  if ($cmd -and $leaf -and ($leaf.Length -ge 8)) {
    $seg = [regex]::Escape($leaf)
    if ($cmd -match ('[\\\\/]' + $seg + '([\\\\/]|\\s|"|''|$)')) { return $true }
  }`
    : "";

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
  }${leafBlock}
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
foreach ($procId in $pids) {
  & taskkill.exe /PID $procId /T /F 2>$null | Out-Null
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
  assertSafeDeleteTarget(targetAbs);
  const quoted = `"${path.resolve(targetAbs).replace(/"/g, '""')}"`;
  spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `attrib -r ${quoted}\\* /s /d`], {
    stdio: "ignore",
    timeout: 120_000,
  });
}
