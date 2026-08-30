import json
import os
import subprocess
import time


def _run(*args, env=None):
    res = subprocess.run(args, capture_output=True, text=True, env=env)
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
        if merged is None:
            return False
        if os.getenv("GITHUB_ACTIONS") == "true":
            _run("git", "restore", "--", path)
            rebase = _run("git", "rebase", "origin/main")
            if rebase.returncode != 0:
                with open(path, "w", encoding="utf-8") as f:
                    json.dump(merged, f, ensure_ascii=False, indent=1)
                _run("git", "add", path)
                rebase = _run(
                    "git",
                    "rebase",
                    "--continue",
                    env=dict(os.environ, GIT_EDITOR="true"),
                )
                if rebase.returncode != 0:
                    _run("git", "rebase", "--abort")
                    print("rebase не удался, попытка", attempt + 1)
                    time.sleep(3 + attempt * 3)
                    continue
        with open(path, "w", encoding="utf-8") as f:
            json.dump(merged, f, ensure_ascii=False, indent=1)
        _run("git", "add", path)
        changed = subprocess.run(
            ["git", "diff", "--cached", "--quiet"], capture_output=True
        ).returncode
        if changed:
            _run("git", "commit", "-m", msg)
        if _run("git", "push").returncode == 0:
            print(f"{path} закоммичен")
            return True
        print("push не удался, попытка", attempt + 1)
        time.sleep(3 + attempt * 3)
    print(f"{path} НЕ закоммичен после 5 попыток")
    return False
