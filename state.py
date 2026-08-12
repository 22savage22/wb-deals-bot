import json
import os
import subprocess
import time

WEEK = 7 * 24 * 3600
PRUNE_AFTER = 14 * 24 * 3600
MAX_KEPT = 20000


def load(path):
    if not os.path.exists(path):
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return normalize(data.get("posted", []))
    except Exception:
        return {}


def load_remote(path, ref="origin/main"):
    res = subprocess.run(
        ["git", "show", f"{ref}:{path}"], capture_output=True, text=True
    )
    if res.returncode != 0:
        return {}
    try:
        data = json.loads(res.stdout)
    except Exception:
        return {}
    return normalize(data.get("posted", []))


def normalize(raw):
    now = time.time()
    out = {}
    for item in raw:
        if isinstance(item, dict):
            pid, ts = item.get("id"), item.get("ts", 0)
        elif isinstance(item, (int, str)):
            pid, ts = item, now
        else:
            continue
        try:
            pid, ts = int(pid), int(ts or 0)
        except (TypeError, ValueError):
            continue
        if now - ts < PRUNE_AFTER:
            out[pid] = max(out.get(pid, 0), ts)
    return out


def merge(local, remote):
    merged = dict(remote)
    for pid, ts in local.items():
        if pid not in merged or ts > merged[pid]:
            merged[pid] = ts
    return merged


def save(path, posted):
    now = time.time()
    clean = {pid: ts for pid, ts in posted.items() if now - ts < PRUNE_AFTER}
    keep = sorted(clean.items(), key=lambda kv: kv[1])[-MAX_KEPT:]
    with open(path, "w", encoding="utf-8") as f:
        json.dump(
            {"posted": [{"id": pid, "ts": ts} for pid, ts in keep]},
            f,
            ensure_ascii=False,
        )