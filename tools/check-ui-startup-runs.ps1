param(
    [Parameter(Mandatory=$true)][string]$HostExe,
    [Parameter(Mandatory=$true)][string]$Out,
    [Parameter(Mandatory=$true)][double]$Hz,
    [int]$UiRuns = 10,
    [int]$NoUiRuns = 5,
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
    foreach ($slot in 1..2) { if ($ui -lt $UiRuns) { $order += 'ui'; $ui++ } }
    if ($noUi -lt $NoUiRuns) { $order += 'noui'; $noUi++ }
}
$passed = @{ ui = 0; noui = 0 }
$index = 0
foreach ($mode in $order) {
    $index++
    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-Process ui-host -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200 }
    $dir = Join-Path $Out ('{0:D2}-{1}' -f $index, $mode)
    New-Item -ItemType Directory -Force $dir | Out-Null
    $hostArgs = @('--entry', 'examples/hud/game.js', '--script', $script)
    if ($mode -eq 'noui') { $hostArgs += '--no-ui' }
    if ($Record) { $hostArgs += @('--record', (Join-Path $dir 'frames')) }
    $load = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
    $ErrorActionPreference = 'Continue'
    & $HostExe @hostArgs *> (Join-Path $dir 'host-console.log')
    $ErrorActionPreference = 'Stop'
    Move-Item -Force frames.csv, host.log $dir
    if (Test-Path ui-host.log) { Move-Item -Force ui-host.log $dir }
    $checkArgs = @((Join-Path $root 'tools\check-ui-startup.py'), $dir, $Hz)
    if ($mode -eq 'noui') { $checkArgs += '--no-ui' }
    $ErrorActionPreference = 'Continue'
    $result = python @checkArgs 2>&1 | Select-Object -Last 1
    $ErrorActionPreference = 'Stop'
    $ok = $LASTEXITCODE -eq 0
    if ($ok) { $passed[$mode]++ }
    Write-Output "$index $mode $(if ($ok) { 'pass' } else { 'FAIL' }) (machine load before run $load%): $result"
}
Write-Output "UI runs passing: $($passed.ui) of $UiRuns; --no-ui runs passing: $($passed.noui) of $NoUiRuns"
