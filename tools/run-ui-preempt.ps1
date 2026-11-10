param(
    [Parameter(Mandatory=$true)][string]$HostExe,
    [Parameter(Mandatory=$true)][string]$Out,
    [string]$Script = 'tools/ui-repro/resize-aba.json'
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $Out, 'tools/ui-repro/out' | Out-Null
Get-ChildItem tools/ui-repro/out -Filter *.png | Remove-Item
$hostProcess = Start-Process -FilePath $HostExe -PassThru -NoNewWindow -ArgumentList @('--entry', 'examples/hud/game.js', '--script', $Script, '--novsync') `
    -RedirectStandardOutput (Join-Path $Out 'host-console.log') -RedirectStandardError (Join-Path $Out 'host-stderr.log')
$null = $hostProcess.Handle
$preempt = Start-Process python -ArgumentList 'tools/ui-repro/preempt.py', $hostProcess.Id -NoNewWindow -PassThru -RedirectStandardOutput (Join-Path $Out 'preempt.log')
$hostProcess.WaitForExit()
$code = $hostProcess.ExitCode
$preempt.WaitForExit(10000) | Out-Null
Move-Item -Force frames.csv, host.log $Out
if (Test-Path ui-host.log) { Move-Item -Force ui-host.log $Out }
Get-ChildItem tools/ui-repro/out -Filter *.png | Move-Item -Force -Destination $Out
Write-Output "host exit $code; $(Get-Content (Join-Path $Out 'preempt.log'))"
python tools/check-ui-resize-captures.py $Out
