param(
    [Parameter(Mandatory=$true)][string]$HostExe,
    [Parameter(Mandatory=$true)][string]$Out,
    [string[]]$Cases = @('once', 'big', 'resize', 'surrogate', 'flood', 'plain', 'pace-vsync', 'pace-novsync')
)
$ErrorActionPreference = 'Stop'
$runs = @{
    once = @('tools/ui-repro/once-click.js', 'tools/ui-repro/click.json')
    big = @('tools/ui-repro/big.js', 'tools/ui-repro/plain.json')
    resize = @('examples/hud/game.js', 'tools/ui-repro/resize.json')
    surrogate = @('tools/ui-repro/surrogate.js', 'tools/ui-repro/surrogate-click.json')
    flood = @('tools/ui-repro/flood.js', 'tools/ui-repro/run600.json')
    plain = @('tools/ui-repro/plain.js', 'tools/ui-repro/run600.json')
    'pace-vsync' = @('examples/hud/game.js', 'tools/ui-repro/run6000.json')
    'pace-novsync' = @('examples/hud/game.js', 'tools/ui-repro/run200000.json', '--novsync')
}
foreach ($case in $Cases) {
    $dir = Join-Path $Out $case
    New-Item -ItemType Directory -Force $dir, 'tools/ui-repro/out' | Out-Null
    $pids = Join-Path $dir 'ui-host-pids.txt'
    $cpu = Join-Path $dir 'ui-host-cpu.csv'
    Set-Content $pids -Value $null
    Set-Content $cpu -Value 'elapsed_s,pid,cpu_s'
    $hostArgs = @('--entry', $runs[$case][0], '--script', $runs[$case][1]) + $runs[$case][2..9]
    $hostProcess = Start-Process -FilePath $HostExe -PassThru -NoNewWindow -ArgumentList $hostArgs `
        -RedirectStandardOutput (Join-Path $dir 'host-console.log') -RedirectStandardError (Join-Path $dir 'host-stderr.log')
    $watch = Start-Job -ArgumentList $hostProcess.Id, $pids, $cpu -ScriptBlock {
        param($hostPid, $file, $cpuFile)
        $seen = @{}
        $started = Get-Date
        while ($true) {
            Get-CimInstance Win32_Process -Filter "Name='ui-host.exe' AND ParentProcessId=$hostPid" |
                ForEach-Object {
                    if (-not $seen.ContainsKey($_.ProcessId)) { $seen[$_.ProcessId] = 1; Add-Content $file $_.ProcessId }
                    $process = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
                    if ($process) { Add-Content $cpuFile ('{0:F2},{1},{2:F3}' -f ((Get-Date) - $started).TotalSeconds, $_.ProcessId, $process.TotalProcessorTime.TotalSeconds) }
                }
            Start-Sleep -Milliseconds 100
        }
    }
    $hostProcess.WaitForExit()
    Start-Sleep -Milliseconds 300
    Stop-Job $watch
    Remove-Job $watch
    Move-Item -Force frames.csv, host.log $dir
    if (Test-Path ui-host.log) { Move-Item -Force ui-host.log $dir }
    Get-ChildItem tools/ui-repro/out -Filter *.png | Move-Item -Force -Destination $dir
    Write-Output "$case done"
}
