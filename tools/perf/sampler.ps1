# Answers one request per stdin line, so the frame-cost tool samples CPU without starting a process per sample.
#   discover <text>  prints the comma-separated IDs of every process whose command line contains <text>, and their descendants
#   cpu <id,id,...>  prints the summed user and kernel CPU milliseconds of the listed processes. The first request for
#                    an ID opens a handle to its process and keeps it, so a process that exits later still reports its
#                    final times and its ID cannot name another process.
#   machine          prints the busy, DPC and interrupt milliseconds summed over every processor, comma-separated
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ProcessorTimes {
  [StructLayout(LayoutKind.Sequential)]
  struct Times { public long Idle, Kernel, User, Dpc, Interrupt; public uint Interrupts; }
  [DllImport("ntdll.dll")]
  static extern int NtQuerySystemInformation(int infoClass, [Out] Times[] times, int length, out int returned);
  public static string Read() {
    var times = new Times[Environment.ProcessorCount];
    int returned;
    int status = NtQuerySystemInformation(8, times, Marshal.SizeOf(typeof(Times)) * times.Length, out returned);
    if (status != 0) throw new InvalidOperationException("NtQuerySystemInformation failed with " + status);
    double busy = 0, dpc = 0, interrupt = 0;
    foreach (var processor in times) {
      busy += processor.Kernel - processor.Idle + processor.User;
      dpc += processor.Dpc;
      interrupt += processor.Interrupt;
    }
    return string.Format(System.Globalization.CultureInfo.InvariantCulture, "{0},{1},{2}", busy / 1e4, dpc / 1e4, interrupt / 1e4);
  }
}
'@
$held = @{}
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
      if (-not $held.ContainsKey($id)) {
        $process = Get-Process -Id ([int]$id) -ErrorAction SilentlyContinue
        if ($process) {
          try { [void]$process.Handle; $held[$id] = $process } catch {}
        }
      }
      if ($held.ContainsKey($id)) { $total += $held[$id].TotalProcessorTime.TotalMilliseconds }
    }
    [Console]::Out.WriteLine($total)
  } elseif ($command -eq 'machine') {
    [Console]::Out.WriteLine([ProcessorTimes]::Read())
  } else {
    [Console]::Out.WriteLine("error unknown command $command")
  }
  [Console]::Out.Flush()
}
