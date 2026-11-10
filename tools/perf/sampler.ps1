# Answers one request per stdin line, so the frame-cost tool samples CPU without starting a process per sample.
#   discover <text>  prints the comma-separated IDs of every process whose command line contains <text>, and their descendants
#   cpu <id,id,...>  prints the summed user and kernel CPU milliseconds of the listed processes that still run
#   all              prints id:milliseconds, comma-separated, for every process whose CPU counters it can read
$ErrorActionPreference = 'Stop'
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $command, $argument = $line -split ' ', 2
  if ($command -eq 'discover') {
    $all = Get-CimInstance Win32_Process
    $ids = [Collections.Generic.HashSet[int]]::new()
    foreach ($process in $all) { if ($process.CommandLine -and $process.CommandLine.Contains($argument)) { [void]$ids.Add([int]$process.ProcessId) } }
    do {
      $added = $false
      foreach ($process in $all) { if ($ids.Contains([int]$process.ParentProcessId) -and $ids.Add([int]$process.ProcessId)) { $added = $true } }
    } while ($added)
    [Console]::Out.WriteLine(($ids -join ','))
  } elseif ($command -eq 'cpu') {
    $total = 0.0
    foreach ($id in $argument -split ',') {
      $process = Get-Process -Id ([int]$id) -ErrorAction SilentlyContinue
      if ($process) { $total += $process.TotalProcessorTime.TotalMilliseconds }
    }
    [Console]::Out.WriteLine($total)
  } elseif ($command -eq 'all') {
    $pairs = foreach ($process in Get-Process) {
      try { '{0}:{1}' -f $process.Id, $process.TotalProcessorTime.TotalMilliseconds } catch {}
    }
    [Console]::Out.WriteLine(($pairs | Where-Object { $_ -notmatch ':$' }) -join ',')
  } else {
    [Console]::Out.WriteLine("error unknown command $command")
  }
  [Console]::Out.Flush()
}
