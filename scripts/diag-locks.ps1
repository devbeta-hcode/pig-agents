$dir = 'C:\Users\HCODE\Desktop\test\portfolio-react'
Write-Host "All node/esbuild:"
Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='esbuild.exe'" -EA SilentlyContinue |
  Select-Object ProcessId, Name, ExecutablePath, CommandLine |
  Format-List

Write-Host "PIDs 7728 9896 if exist:"
foreach ($id in 7728, 9896, 17560) {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -EA SilentlyContinue
  if ($p) { $p | Select-Object ProcessId, Name, CommandLine | Format-List }
}

Write-Host "Processes with CommandLine containing 'test' or 'portfolio':"
Get-CimInstance Win32_Process -EA SilentlyContinue |
  Where-Object { $_.CommandLine -match 'portfolio-react|Desktop\\test' } |
  Select-Object ProcessId, Name, @{N='Cmd';E={$_.CommandLine}} |
  Format-List
