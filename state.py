import json
import os
import subprocess
import time

WEEK = 7 * 24 * 3600
PRUNE_AFTER = 14 * 24 * 3600
FEEDBACK_KEEP = 30 * 24 * 3600
RECENT_KEEP = 14 * 24 * 3600
MAX_KEPT = 20000
RECENT_MAX = 60


def _empty():
    return {
        "posted": {},
        "feedback": {},
        "query_stats": {},
        "cat_stats": {},
        "tg": {"offset": 0},
        "recent": [],
        "meta": {},
    }


def _norm_posted(raw):
    now = time.time()
    out = {}
    for item in raw or []:
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


def _norm_feedback(raw):
    now = time.time()
    out = {}
    for pid, fb in (raw or {}).items():
        if not isinstance(fb, dict):
            continue
        try:
            pid = int(pid)
        except (TypeError, ValueError):
            continue
        ts = int(fb.get("ts", 0) or 0)
        if now - ts >= FEEDBACK_KEEP:
            continue
        out[pid] = {
            "likes": int(fb.get("likes", 0) or 0),
            "dislikes": int(fb.get("dislikes", 0) or 0),
            "bought": int(fb.get("bought", 0) or 0),
            "ts": ts,
            "query": fb.get("query"),
            "cat": fb.get("cat"),
        }
    return out


def _norm_stats(raw):
    out = {}
    for key, st in (raw or {}).items():
        if isinstance(st, dict):
            out[str(key)] = {
                "posts": float(st.get("posts", 0) or 0),
                "likes": float(st.get("likes", 0) or 0),
                "dislikes": float(st.get("dislikes", 0) or 0),
                "bought": float(st.get("bought", 0) or 0),
                "ts": float(st.get("ts", 0) or 0),
            }
    return out


def _norm_tg(raw):
    try:
        offset = int((raw or {}).get("offset", 0) or 0)
    except (TypeError, ValueError):
        offset = 0
    return {"offset": offset}


def _norm_recent(raw):
    now = time.time()
    seen = {}
    for r in raw or []:
        if not isinstance(r, dict):
            continue
        try:
            pid = int(r.get("pid", 0) or 0)
        except (TypeError, ValueError):
            continue
        ts = int(r.get("ts", 0) or 0)
        if not pid or now - ts >= RECENT_KEEP:
            continue
        if pid not in seen or ts > seen[pid]["ts"]:
            seen[pid] = r
    items = sorted(seen.values(), key=lambda r: r["ts"], reverse=True)[:RECENT_MAX]
    return items


def _norm_meta(raw):
    out = {}
    for key, val in (raw or {}).items():
        out[str(key)] = val
    return out


def _from_dict(data):
    data = data or {}
    return {
        "posted": _norm_posted(data.get("posted")),
        "feedback": _norm_feedback(data.get("feedback")),
        "query_stats": _norm_stats(data.get("query_stats")),
        "cat_stats": _norm_stats(data.get("cat_stats")),
        "tg": _norm_tg(data.get("tg")),
        "recent": _norm_recent(data.get("recent")),
        "meta": _norm_meta(data.get("meta")),
    }


def load(path):
    if not os.path.exists(path):
        return _empty()
    try:
        with open(path, encoding="utf-8") as f:
            return _from_dict(json.load(f))
    except Exception:
        return _empty()


def load_remote(path, ref="origin/main"):
    res = subprocess.run(
        ["git", "show", f"{ref}:{path}"], capture_output=True, text=True
    )
    if res.returncode != 0:
        return None
    try:
        return _from_dict(json.loads(res.stdout))
    except Exception:
        return None


def merge(local, remote):
    base = remote if remote is not None else _empty()
    m = {
        "posted": dict(base["posted"]),
        "feedback": dict(base["feedback"]),
        "query_stats": dict(base["query_stats"]),
        "cat_stats": dict(base["cat_stats"]),
        "tg": dict(base["tg"]),
        "recent": list(base["recent"]),
        "meta": dict(base["meta"]),
    }
    for pid, ts in local["posted"].items():
        if pid not in m["posted"] or ts > m["posted"][pid]:
            m["posted"][pid] = ts
    for pid, fb in local["feedback"].items():
        if (
            pid not in m["feedback"]
            or fb.get("ts", 0) > m["feedback"][pid].get("ts", 0)
        ):
            m["feedback"][pid] = fb
    for key, st in local["query_stats"].items():
        if key not in m["query_stats"] or st.get("ts", 0) > m["query_stats"][key].get(
            "ts", 0
        ):
            m["query_stats"][key] = st
    for key, st in local["cat_stats"].items():
        if key not in m["cat_stats"] or st.get("ts", 0) > m["cat_stats"][key].get(
            "ts", 0
        ):
            m["cat_stats"][key] = st
    m["tg"]["offset"] = max(m["tg"]["offset"], local["tg"]["offset"])
    for r in local["recent"]:
        pid = r.get("pid")
        if pid is None:
            continue
        found = next((x for x in m["recent"] if x.get("pid") == pid), None)
        if found is None or r["ts"] > found["ts"]:
            if found is not None:
                m["recent"].remove(found)
            m["recent"].append(r)
    m["meta"].update(local["meta"])
    return m


def save(path, data):
    now = time.time()
    data["posted"] = {
        pid: ts
        for pid, ts in data["posted"].items()
        if now - ts < PRUNE_AFTER
    }
    keep = sorted(data["posted"].items(), key=lambda kv: kv[1])[-MAX_KEPT:]
    data["posted"] = dict(keep)
    data["feedback"] = {
        pid: fb
        for pid, fb in data["feedback"].items()
        if now - fb.get("ts", 0) < FEEDBACK_KEEP
    }
    data["recent"] = _norm_recent(data["recent"])
    data["recent"] = sorted(
        data["recent"], key=lambda r: r["ts"], reverse=True
    )[:RECENT_MAX]
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)