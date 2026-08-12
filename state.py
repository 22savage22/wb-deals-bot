import json
import os

MAX_KEPT = 4000


def load(path):
    if not os.path.exists(path):
        return set()
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return set(data.get("posted", []))
    except Exception:
        return set()


def save(path, posted):
    keep = list(posted)[-MAX_KEPT:]
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"posted": keep}, f, ensure_ascii=False)
