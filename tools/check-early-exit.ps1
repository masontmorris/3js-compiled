param([Parameter(Mandatory=$true)][string]$HostExe, [Parameter(Mandatory=$true)][string]$Entry, [int]$Seconds = 30)
$ErrorActionPreference = 'Stop'
$dir = Join-Path ([IO.Path]::GetTempPath()) "threejsc-early-exit-$PID"
New-Item -ItemType Directory -Force $dir | Out-Null
$hostCopy = Join-Path $dir 'host.exe'
$stub = Join-Path $dir 'ui-host.exe'
Copy-Item $HostExe $hostCopy
Copy-Item "$env:SystemRoot\System32\whoami.exe" $stub
$p = Start-Process -FilePath $hostCopy -PassThru -WindowStyle Hidden -ArgumentList @('--entry', $Entry)
try {
    Start-Sleep -Seconds 5
    $p.Refresh()
    $first = @{ threads = $p.Threads.Count; handles = $p.HandleCount }
    Start-Sleep -Seconds $Seconds
    $p.Refresh()
    $last = @{ threads = $p.Threads.Count; handles = $p.HandleCount }
    if ($p.HasExited) { throw "host exited with $($p.ExitCode) while ui-host kept exiting" }
} finally {
    if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force; $p.WaitForExit() }
}
Start-Sleep -Seconds 1
$early = @(Select-String -Path host.log -SimpleMatch 'ui-host exited before pipe connection').Count
$left = @(Get-CimInstance Win32_Process -Filter "Name='ui-host.exe' AND ParentProcessId=$($p.Id)").Count
Remove-Item -Recurse -Force $dir
Write-Output "early exits $early; threads $($first.threads) -> $($last.threads); handles $($first.handles) -> $($last.handles); stub processes left $left"
if ($early -lt 2) { throw 'host.log records fewer than two ui-host exits before the pipe connected' }
if ($left -gt 0) { throw 'ui-host processes outlived the host' }
if ($last.threads -gt $first.threads + 2 -or $last.handles -gt $first.handles + 10) { throw 'host leaked threads or handles while ui-host kept exiting' }
