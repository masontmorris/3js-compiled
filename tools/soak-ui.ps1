param(
    [Parameter(Mandatory=$true)][string]$HostExe,
    [Parameter(Mandatory=$true)][string]$Out,
    [string]$Entry = 'examples/hud/game.js',
    [int]$Seconds = 600,
    [double]$Hz = 169,
    [double]$ResizeEvery = 0,
    [string[]]$HostArgs = @()
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $Out | Out-Null
$steps = if ($ResizeEvery -gt 0) {
    $sizes = '"width":1920,"height":1080', '"width":1280,"height":720'
    "{`"type`":`"wait`",`"frames`":$([int](15 * $Hz))}"
    for ($elapsed = 0; $elapsed -lt $Seconds; $elapsed += $ResizeEvery) {
        $wait = [math]::Min($ResizeEvery, $Seconds - $elapsed)
        $size = [int][math]::Floor($elapsed / $ResizeEvery) % 2
        "{`"type`":`"resize`",$($sizes[$size])},{`"type`":`"wait`",`"frames`":$([int]($wait * $Hz))}"
    }
} else {
    "{`"type`":`"wait`",`"frames`":$([int](($Seconds + 15) * $Hz))}"
}
$script = Join-Path $Out 'soak.json'
"[$($steps -join ','),{`"type`":`"close`"}]" | Set-Content -Encoding ascii $script
$samples = Join-Path $Out 'samples.csv'
'elapsed_s,proc,pid,handles,working_set_mb,private_mb,gpu_dedicated_mb,window' | Set-Content -Encoding ascii $samples
$started = Get-Date
$p = Start-Process -FilePath $HostExe -PassThru -WindowStyle Hidden -ArgumentList (@('--entry', "`"$Entry`"", '--script', "`"$script`"") + $HostArgs) `
    -RedirectStandardOutput (Join-Path $Out 'host-stdout.log') -RedirectStandardError (Join-Path $Out 'host-stderr.log')
Add-Type -Namespace Soak -Name Win -MemberDefinition '[DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr window, int[] rect);'
function Get-WindowSize($process) {
    $rect = [int[]]::new(4)
    if ([Soak.Win]::GetClientRect($process.MainWindowHandle, $rect)) { '{0}x{1}' -f $rect[2], $rect[3] }
}
function Get-GpuDedicated($id) {
    foreach ($try in 1..3) {
        try {
            $counter = Get-Counter "\GPU Process Memory(pid_$($id)_*)\Dedicated Usage" -ErrorAction Stop
            return ($counter.CounterSamples | Measure-Object CookedValue -Sum).Sum / 1MB
        } catch {}
    }
}
function Get-Sample($elapsed, $name, $id) {
    $before = Get-WindowSize $p
    $process = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($process) {
        $gpu = Get-GpuDedicated $id
        $after = Get-WindowSize $p
        [string]::Format([Globalization.CultureInfo]::InvariantCulture, '{0:F1},{1},{2},{3},{4:F3},{5:F3},{6:F3},{7}', $elapsed, $name, $id, $process.HandleCount,
            ($process.WorkingSet64 / 1MB), ($process.PrivateMemorySize64 / 1MB), $gpu, $(if ($before -eq $after) { $before }))
    }
}
while (-not $p.HasExited) {
    $elapsed = ((Get-Date) - $started).TotalSeconds
    $p.Refresh()
    $rows = @(Get-Sample $elapsed 'host' $p.Id) + @(Get-CimInstance Win32_Process -Filter "Name='ui-host.exe' AND ParentProcessId=$($p.Id)" |
        ForEach-Object { Get-Sample $elapsed 'ui-host' $_.ProcessId })
    if (-not $p.HasExited) { $rows | Add-Content $samples }
    $next = $started.AddSeconds(10 * ([math]::Floor($elapsed / 10) + 1))
    while ((Get-Date) -lt $next -and -not $p.HasExited) { Start-Sleep -Milliseconds 200 }
}
Move-Item -Force frames.csv, host.log $Out
if (Test-Path ui-host.log) { Move-Item -Force ui-host.log $Out }
Write-Output "host exited $($p.ExitCode) after $([math]::Round(((Get-Date) - $started).TotalSeconds)) s"
if ($p.ExitCode -ne 0) { exit $p.ExitCode }
