param(
    [Parameter(Mandatory=$true)][string]$HostExe,
    [Parameter(Mandatory=$true)][string]$Out,
    [string]$Entry = 'examples/hud/game.js',
    [int]$Seconds = 600,
    [double]$Hz = 169,
    [string[]]$HostArgs = @()
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $Out | Out-Null
$frames = [int](($Seconds + 15) * $Hz)
$script = Join-Path $Out 'soak.json'
"[{`"type`":`"wait`",`"frames`":$frames},{`"type`":`"close`"}]" | Set-Content -Encoding ascii $script
$samples = Join-Path $Out 'samples.csv'
'elapsed_s,proc,pid,handles,working_set_mb,private_mb' | Set-Content -Encoding ascii $samples
$started = Get-Date
$p = Start-Process -FilePath $HostExe -PassThru -WindowStyle Hidden -ArgumentList (@('--entry', $Entry, '--script', $script) + $HostArgs) `
    -RedirectStandardOutput (Join-Path $Out 'host-stdout.log') -RedirectStandardError (Join-Path $Out 'host-stderr.log')
function Add-Sample($elapsed, $name, $process) {
    if ($process) {
        '{0:F1},{1},{2},{3},{4:F3},{5:F3}' -f $elapsed, $name, $process.Id, $process.HandleCount,
            ($process.WorkingSet64 / 1MB), ($process.PrivateMemorySize64 / 1MB) | Add-Content $samples
    }
}
while (-not $p.HasExited) {
    $elapsed = ((Get-Date) - $started).TotalSeconds
    $p.Refresh()
    Add-Sample $elapsed 'host' $p
    Get-CimInstance Win32_Process -Filter "Name='ui-host.exe' AND ParentProcessId=$($p.Id)" |
        ForEach-Object { Add-Sample $elapsed 'ui-host' (Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue) }
    $next = $started.AddSeconds(10 * ([math]::Floor($elapsed / 10) + 1))
    while ((Get-Date) -lt $next -and -not $p.HasExited) { Start-Sleep -Milliseconds 200 }
}
Move-Item -Force frames.csv, host.log $Out
if (Test-Path ui-host.log) { Move-Item -Force ui-host.log $Out }
Write-Output "host exited $($p.ExitCode) after $([math]::Round(((Get-Date) - $started).TotalSeconds)) s"
