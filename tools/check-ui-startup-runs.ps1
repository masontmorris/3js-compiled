param(
    [Parameter(Mandatory=$true)][string]$HostExe,
    [Parameter(Mandatory=$true)][string]$Out,
    [Parameter(Mandatory=$true)][double]$Hz,
    [int]$UiRuns = 30,
    [int]$NoUiRuns = 30,
    [switch]$Record
)
$ErrorActionPreference = 'Stop'
$root = (Get-Location).Path
New-Item -ItemType Directory -Force $Out | Out-Null
$script = Join-Path $Out 'startup.json'
'[{"type":"wait","frames":300},{"type":"close"}]' | Set-Content -Encoding ascii $script
$order = @()
$ui = 0
$noUi = 0
while ($ui -lt $UiRuns -or $noUi -lt $NoUiRuns) {
    if ($ui -lt $UiRuns) { $order += 'ui'; $ui++ }
    if ($noUi -lt $NoUiRuns) { $order += 'noui'; $noUi++ }
}
$over = @{ ui = 0; noui = 0 }
$hudOver = 0
$failed = 0
$index = 0
$previous = $null
foreach ($mode in $order) {
    $index++
    $deadline = (Get-Date).AddSeconds(10)
    while ($previous -and (Get-CimInstance Win32_Process -Filter "Name='ui-host.exe' AND ParentProcessId=$previous") -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 200
    }
    $dir = Join-Path $Out ('{0:D2}-{1}' -f $index, $mode)
    New-Item -ItemType Directory -Force $dir | Out-Null
    $hostArgs = @('--entry', 'examples/hud/game.js', '--script', $script)
    if ($mode -eq 'noui') { $hostArgs += '--no-ui' }
    if ($Record) { $hostArgs += @('--record', (Join-Path $dir 'frames')) }
    $load = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
    $hostProcess = Start-Process -FilePath $HostExe -PassThru -NoNewWindow -ArgumentList $hostArgs `
        -RedirectStandardOutput (Join-Path $dir 'host-console.log') -RedirectStandardError (Join-Path $dir 'host-stderr.log')
    $hostProcess.WaitForExit()
    $previous = $hostProcess.Id
    Move-Item -Force frames.csv, host.log $dir
    if (Test-Path ui-host.log) { Move-Item -Force ui-host.log $dir }
    $checkArgs = @((Join-Path $root 'tools\check-ui-startup.py'), $dir, $Hz)
    if ($mode -eq 'noui') { $checkArgs += '--no-ui' }
    $ErrorActionPreference = 'Continue'
    $result = python @checkArgs 2>&1 | Select-Object -Last 1
    $ErrorActionPreference = 'Stop'
    if ($LASTEXITCODE -ne 0) { $failed++ }
    if ("$result" -match 'over=(\d+)') { $over[$mode] += [int]$Matches[1] }
    if ("$result" -match 'hud_over=(\d+)') { $hudOver += [int]$Matches[1] }
    Write-Output "$index $mode $(if ($LASTEXITCODE -eq 0) { 'pass' } else { 'FAIL' }) (machine load before run $load%): $result"
}
$pass = $failed -eq 0 -and $over.ui -le $over.noui
Write-Output "first-second intervals over $([math]::Round(2000 / $Hz, 3)) ms: UI $($over.ui) in $UiRuns runs, --no-ui $($over.noui) in $NoUiRuns runs; UI intervals over it from the HUD's first frame through 30 frames after: $hudOver; failed runs $failed; rule $(if ($pass) { 'PASS' } else { 'FAIL' })"
if (-not $pass -and -not $Record) { exit 1 }
