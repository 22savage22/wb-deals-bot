import json
import os
import subprocess
import time


def _run(*args):
    res = subprocess.run(args, capture_output=True, text=True)
    if res.returncode != 0:
        print("git error:", " ".join(args), "->", res.returncode)
        print((res.stderr or res.stdout).strip()[:400])
    return res


def _load_json_ref(path, ref="origin/main"):
    res = subprocess.run(
        ["git", "show", f"{ref}:{path}"], capture_output=True, text=True
    )
    if res.returncode != 0:
        return None
    try:
        return json.loads(res.stdout)
    except Exception:
        return None


def commit(path, merge_fn, msg):
    if not os.getenv("GITHUB_TOKEN"):
        print("GITHUB_TOKEN не задан, коммит пропущен:", path)
        return False
    _run("git", "config", "user.name", "wb-bot")
    _run("git", "config", "user.email", "actions@github.com")
    for attempt in range(5):
        _run("git", "fetch", "origin", "main")
        remote = _load_json_ref(path)
        merged = merge_fn(remote)
        if merged is not None:
            with open(path, "w", encoding="utf-8") as f:
                json.dump(merged, f, ensure_ascii=False, indent=1)
        _run("git", "add", path)
        res = _run("git", "commit", "-m", msg)
        if res.returncode != 0:
            print(f"{path} не изменился — коммит пропущен")
            return True
        if _run("git", "push").returncode == 0:
            print(f"{path} закоммичен")
            return True
        print("push не удался, попытка", attempt + 1)
        time.sleep(3 + attempt * 3)
    print(f"{path} НЕ закоммичен после 5 попыток")
    return False