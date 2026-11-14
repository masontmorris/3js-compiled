# Simulates a busy CPU: suspends the ui-host child of host process PID for 8 ms out of every 20 ms until it exits.
import ctypes, subprocess, sys, time
from ctypes import wintypes
k32 = ctypes.WinDLL("kernel32", use_last_error=True); nt = ctypes.WinDLL("ntdll")
k32.OpenProcess.restype = wintypes.HANDLE
k32.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
k32.CloseHandle.argtypes = (wintypes.HANDLE,)
nt.NtSuspendProcess.argtypes = (wintypes.HANDLE,)
nt.NtResumeProcess.argtypes = (wintypes.HANDLE,)
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
if not h: raise ctypes.WinError(ctypes.get_last_error())
# STATUS_PROCESS_IS_TERMINATING: ui-host began exiting after the last wait.
TERMINATING = -0x3FFFFEF6
n = 0
try:
    while True:
        wait = k32.WaitForSingleObject(h, 0)
        if wait == 0: break
        if wait != 0x102: raise ctypes.WinError(ctypes.get_last_error())
        status = nt.NtSuspendProcess(h)
        if status == TERMINATING: break
        if status < 0: raise OSError(f'NtSuspendProcess failed: {status:#x}')
        try:
            time.sleep(0.008)
        finally:
            status = nt.NtResumeProcess(h)
            if status < 0 and status != TERMINATING: raise OSError(f'NtResumeProcess failed: {status:#x}')
        time.sleep(0.012); n += 1
finally:
    k32.CloseHandle(h)
print(f"preempted ui-host {pid} {n} times")
