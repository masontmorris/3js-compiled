param([Parameter(Mandatory=$true)][string]$HostExe, [Parameter(Mandatory=$true)][string]$Entry, [Parameter(Mandatory=$true)][string]$Script)
$ErrorActionPreference = 'Stop'
$p = Start-Process -FilePath $HostExe -PassThru -WindowStyle Hidden -ArgumentList @('--entry', $Entry, '--script', $Script)
try {
    Start-Sleep -Seconds 8
    $p.Refresh()
    $first = @{ threads = $p.Threads.Count; handles = $p.HandleCount }
    Start-Sleep -Seconds 30
    $p.Refresh()
    $last = @{ threads = $p.Threads.Count; handles = $p.HandleCount }
    Write-Output "threads $($first.threads) -> $($last.threads); handles $($first.handles) -> $($last.handles)"
    if ($p.HasExited -or $last.threads -gt $first.threads + 2 -or $last.handles -gt $first.handles + 10) { throw 'Host leaked resources while child exited before connecting' }
} finally {
    if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force; $p.WaitForExit() }
}
