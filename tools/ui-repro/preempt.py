# Simulates a busy CPU: suspends ui-host for 8 ms out of every 20 ms until it exits.
import ctypes, subprocess, sys, time
from ctypes import wintypes
k32 = ctypes.WinDLL("kernel32", use_last_error=True); nt = ctypes.WinDLL("ntdll")
k32.OpenProcess.restype = wintypes.HANDLE
exe = sys.argv[1].lower()
def find():
    out = subprocess.run(["powershell", "-NoProfile", "-c",
        "Get-CimInstance Win32_Process -Filter \"Name='ui-host.exe'\" | ForEach-Object { \"$($_.ProcessId)|$($_.ExecutablePath)\" }"],
        capture_output=True, text=True).stdout
    for line in out.splitlines():
        pid, _, path = line.partition("|")
        if path.lower() == exe: return int(pid)
deadline = time.time() + 60
pid = None
while pid is None and time.time() < deadline:
    pid = find(); time.sleep(0.2)
if pid is None: sys.exit("no ui-host")
h = k32.OpenProcess(0x0800 | 0x1000 | 0x00100000, False, pid)  # SUSPEND_RESUME | QUERY_LIMITED | SYNCHRONIZE
n = 0
while k32.WaitForSingleObject(h, 0) != 0:
    nt.NtSuspendProcess(h); time.sleep(0.008); nt.NtResumeProcess(h); time.sleep(0.012); n += 1
print(f"preempted ui-host {pid} {n} times")
