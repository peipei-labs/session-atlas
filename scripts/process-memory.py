"""Read-only macOS process memory snapshot; never collect command arguments."""
import ctypes
import json
import os
import subprocess
import sys


class RUsage(ctypes.Structure):
    # rusage_info_v0, from the macOS SDK's sys/resource.h.
    _fields_ = [("uuid", ctypes.c_uint8 * 16)] + [
        (name, ctypes.c_uint64) for name in (
            "user_time", "system_time", "pkg_idle_wkups", "interrupt_wkups",
            "pageins", "wired_size", "resident_size", "phys_footprint",
            "proc_start_abstime", "proc_exit_abstime",
        )
    ]


def main():
    if sys.platform != "darwin":
        raise RuntimeError("Memory sampling requires macOS")
    lib = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
    lib.proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
    lib.proc_pid_rusage.restype = ctypes.c_int
    output = subprocess.check_output(
        ["/bin/ps", "-axo", "pid=,ppid=,tty=,rss=,comm="], text=True, timeout=5,
    )
    rows = []
    for line in output.splitlines():
        fields = line.split(None, 4)
        if len(fields) != 5:
            continue
        pid, ppid, tty, rss, command = fields
        info = RUsage()
        ok = lib.proc_pid_rusage(int(pid), 0, ctypes.byref(info)) == 0
        rows.append(dict(pid=int(pid), ppid=int(ppid), tty=tty,
                         rssBytes=int(info.resident_size) if ok else int(rss) * 1024,
                         footprintBytes=int(info.phys_footprint) if ok else None,
                         name=os.path.basename(command)))
    print(json.dumps(rows))


if __name__ == "__main__":
    main()
