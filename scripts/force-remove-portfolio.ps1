$dir = 'C:\Users\HCODE\Desktop\test\portfolio-react'
if (-not (Test-Path -LiteralPath $dir)) {
  Write-Host "Already gone: $dir"
  exit 0
}

Write-Host "Target: $dir"
Write-Host ""
Write-Host "=== Matching processes ==="
$hits = @()
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object {
  $exe = $_.ExecutablePath
  $cmd = $_.CommandLine
  $hit = $false
  if ($exe -and $exe.StartsWith($dir, [System.StringComparison]::OrdinalIgnoreCase)) { $hit = $true }
  if (-not $hit -and $cmd -and ($cmd.IndexOf($dir, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)) { $hit = $true }
  if (-not $hit -and $cmd -and ($cmd -match '[\\/]portfolio-react[\\/]')) { $hit = $true }
  if ($hit) {
    $hits += $_
    Write-Host ("PID {0} {1}" -f $_.ProcessId, $_.Name)
    if ($exe) { Write-Host "  exe: $exe" }
    if ($cmd) {
      $len = [Math]::Min(160, $cmd.Length)
      Write-Host "  cmd: $($cmd.Substring(0, $len))"
    }
  }
}

if ($hits.Count -eq 0) {
  Write-Host "(no WMI matches; checking Get-Process paths under folder)"
  Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $_.Path -and ($_.Path.StartsWith($dir, [System.StringComparison]::OrdinalIgnoreCase))
  } | ForEach-Object {
    Write-Host ("PID {0} {1} path={2}" -f $_.Id, $_.ProcessName, $_.Path)
    $hits += [pscustomobject]@{ ProcessId = $_.Id }
  }
}

foreach ($p in ($hits | Sort-Object ProcessId -Unique)) {
  $procId = [int]$p.ProcessId
  Write-Host "taskkill /T /F PID $procId"
  & taskkill.exe /PID $procId /T /F 2>$null | Out-Null
}

Start-Sleep -Seconds 2
Write-Host ""
Write-Host "=== attrib -r ==="
cmd /c "attrib -r `"$dir\*`" /s /d" 2>$null | Out-Null

Write-Host ""
Write-Host "=== rd /s /q ==="
cmd /c "rd /s /q `"$dir`""
if (Test-Path -LiteralPath $dir) {
  Write-Host "FAILED - folder still exists."
  Write-Host "Close Pig Agents terminals, Cursor terminal, File Explorer on this folder, then run this script again."
  exit 1
}
Write-Host "OK - deleted."
exit 0
