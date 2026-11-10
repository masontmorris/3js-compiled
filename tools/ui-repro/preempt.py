# Simulates a busy CPU: suspends the ui-host child of host process PID for 8 ms out of every 20 ms until it exits.
import ctypes, subprocess, sys, time
from ctypes import wintypes
k32 = ctypes.WinDLL("kernel32", use_last_error=True); nt = ctypes.WinDLL("ntdll")
k32.OpenProcess.restype = wintypes.HANDLE
host = int(sys.argv[1])
def find():
    out = subprocess.run(["powershell", "-NoProfile", "-c",
        f"Get-CimInstance Win32_Process -Filter \"Name='ui-host.exe' AND ParentProcessId={host}\" | ForEach-Object ProcessId"],
        capture_output=True, text=True).stdout.split()
    return int(out[0]) if out else None
deadline = time.time() + 60
pid = None
while pid is None and time.time() < deadline:
    pid = find(); time.sleep(0.2)
if pid is None: sys.exit(f"no ui-host child of host {host}")
h = k32.OpenProcess(0x0800 | 0x1000 | 0x00100000, False, pid)  # SUSPEND_RESUME | QUERY_LIMITED | SYNCHRONIZE
n = 0
while k32.WaitForSingleObject(h, 0) != 0:
    nt.NtSuspendProcess(h); time.sleep(0.008); nt.NtResumeProcess(h); time.sleep(0.012); n += 1
print(f"preempted ui-host {pid} {n} times")
