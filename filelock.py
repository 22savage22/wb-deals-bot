"""Minimal file locking for concurrent processes.

Uses fcntl.flock on Linux (GitHub Actions), msvcrt.locking on Windows.
"""

import os
import sys
import time

if sys.platform == "win32":
    import msvcrt
else:
    import fcntl


class FileLock:
    """Context manager that holds an exclusive file lock.

    On Linux: uses fcntl.flock (advisory, works across forks).
    On Windows: uses msvcrt.locking (mandatory for the same process).
    """

    def __init__(self, path):
        self._lock_path = path + ".lock"
        self._fd = None

    def __enter__(self):
        self._fd = os.open(self._lock_path, os.O_CREAT | os.O_RDWR, 0o666)
        try:
            if sys.platform == "win32":
                # msvcrt.locking retries on lock contention
                for attempt in range(100):
                    try:
                        msvcrt.locking(self._fd, msvcrt.LK_NBLCK, 1)
                        return self
                    except OSError:
                        time.sleep(0.01)
                # Last resort: block with LCK_LOCK
                msvcrt.locking(self._fd, msvcrt.LK_LOCK, 1)
            else:
                fcntl.flock(self._fd, fcntl.LOCK_EX)
        except OSError:
            # Close fd if locking fails to prevent descriptor leak
            os.close(self._fd)
            self._fd = None
            raise
        return self

    def __exit__(self, *exc):
        if self._fd is not None:
            try:
                if sys.platform == "win32":
                    msvcrt.locking(self._fd, msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(self._fd, fcntl.LOCK_UN)
            except OSError:
                pass
            os.close(self._fd)
            self._fd = None
        return False


def atomic_replace(tmp_path, target):
    """Cross-platform atomic replace.

    On Windows os.replace() can briefly fail while a reader or AV holds
    the target, so retry a few times.  Never delete the target: if replace
    keeps failing, raise and leave the original file intact.
    """
    last = None
    for _ in range(10):
        try:
            os.replace(tmp_path, target)
            return
        except PermissionError as exc:
            last = exc
            time.sleep(0.05)
    raise last


def safe_save_json(path, data, indent=1):
    """Atomically save JSON with file locking.

    Creates a temp file, writes JSON, then replaces the target atomically.
    Uses FileLock to prevent concurrent corruption.
    """
    import json, tempfile
    dir_name = os.path.dirname(os.path.abspath(path))
    fd, tmp_path = tempfile.mkstemp(dir=dir_name, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=indent)
        # mkstemp creates 0600; keep parity with files written via open().
        os.chmod(tmp_path, 0o644)
        with FileLock(path):
            atomic_replace(tmp_path, path)
    except BaseException:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise
