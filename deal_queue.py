"""Persistent deal queue stored separately from frequently updated bot state."""

import json
import os
import subprocess

import state


def normalize(raw):
    return state._norm_queue(raw)


def merge(local, remote, posted=None, removed=None):
    posted = posted or {}
    removed = set(removed or ())
    combined = {item["id"]: item for item in normalize(remote)}
    for item in normalize(local):
        old = combined.get(item["id"])
        if old is None or item["queued_ts"] > old["queued_ts"]:
            combined[item["id"]] = item
    return normalize(
        [
            item for pid, item in combined.items()
            if pid not in posted and pid not in removed
        ]
    )


def _local(path):
    if not os.path.exists(path):
        return []
    try:
        with open(path, encoding="utf-8") as f:
            return normalize(json.load(f))
    except Exception:
        return []


def _remote(path, ref="origin/main"):
    try:
        res = subprocess.run(
            ["git", "show", f"{ref}:{path}"],
            capture_output=True,
            text=True,
            timeout=20,
        )
        if res.returncode != 0:
            return []
        return normalize(json.loads(res.stdout))
    except Exception:
        return []


def load(path):
    return merge(_local(path), _remote(path))


def save(path, queue, posted=None):
    clean = merge(queue, [], posted)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(clean, f, ensure_ascii=False, indent=1)
    return clean
