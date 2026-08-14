import json
import os
import subprocess
import time

WEEK = 7 * 24 * 3600
PRUNE_AFTER = 14 * 24 * 3600
FEEDBACK_KEEP = 30 * 24 * 3600
RECENT_KEEP = 14 * 24 * 3600
IMG_KEEP = 30 * 24 * 3600
LEARNED_KEEP = 60 * 24 * 3600
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
        "admin_ui": {"pending": None},
        "titles": {},
        "img_hash": {},
        "learned": {},
    }


def _norm_posted(raw):
    now = time.time()
    out = {}
    if isinstance(raw, dict):
        pairs = list(raw.items())
    else:
        pairs = [(item, now) for item in (raw or [])]
    for item, item_ts in pairs:
        if isinstance(item, dict):
            pid, ts = item.get("id"), item.get("ts", 0)
        elif isinstance(item, (int, str)):
            pid, ts = item, item_ts
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
    if not isinstance(raw, dict):
        return {}
    now = time.time()
    out = {}
    for pid, fb in raw.items():
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
            "voters": {
                str(k): float(v or 0)
                for k, v in (fb.get("voters") or {}).items()
                if isinstance(v, (int, float))
            },
        }
    return out


def _norm_stats(raw):
    if not isinstance(raw, dict):
        return {}
    out = {}
    for key, st in raw.items():
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
    if not isinstance(raw, dict):
        return {"offset": 0}
    try:
        offset = int(raw.get("offset", 0) or 0)
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
    if not isinstance(raw, dict):
        return {}
    out = {}
    for key, val in raw.items():
        out[str(key)] = val
    return out


def _norm_titles(raw):
    if not isinstance(raw, dict):
        return {}
    now = time.time()
    out = {}
    for title, ts in raw.items():
        if not isinstance(title, str) or not title:
            continue
        try:
            ts = int(ts or 0)
        except (TypeError, ValueError):
            continue
        if now - ts < PRUNE_AFTER:
            out[title] = max(out.get(title, 0), ts)
    return out


def _norm_img_hash(raw):
    if not isinstance(raw, dict):
        return {}
    now = time.time()
    out = {}
    for h, ts in raw.items():
        if not isinstance(h, str) or not h:
            continue
        try:
            ts = int(ts or 0)
        except (TypeError, ValueError):
            continue
        if now - ts < IMG_KEEP:
            out[h] = max(out.get(h, 0), ts)
    return out


def _norm_learned(raw):
    if not isinstance(raw, dict):
        return {}
    out = {}
    for query, st in raw.items():
        if not isinstance(query, str) or not query:
            continue
        if not isinstance(st, dict):
            continue
        try:
            ts = float(st.get("ts", 0) or 0)
            attempts = int(st.get("attempts", 0) or 0)
            posts = int(st.get("posts", 0) or 0)
        except (TypeError, ValueError):
            continue
        status = st.get("status")
        if status not in ("trial", "active", "retired"):
            status = "active" if posts else "trial"
        out[query] = {"ts": ts, "attempts": attempts, "posts": posts, "status": status}
    return out


def _norm_admin_ui(raw):
    if not isinstance(raw, dict):
        return {"pending": None}
    pending = raw.get("pending")
    if not isinstance(pending, str):
        pending = None
    return {"pending": pending}


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
        "admin_ui": _norm_admin_ui(data.get("admin_ui")),
        "titles": _norm_titles(data.get("titles")),
        "img_hash": _norm_img_hash(data.get("img_hash")),
        "learned": _norm_learned(data.get("learned")),
    }


def load(path):
    local = _load_local(path)
    remote = load_remote(path)
    if remote is None:
        return local
    return merge(local, remote)


def _load_local(path):
    if not os.path.exists(path):
        return _empty()
    try:
        with open(path, encoding="utf-8") as f:
            return _from_dict(json.load(f))
    except Exception:
        return _empty()


def load_remote(path, ref="origin/main"):
    try:
        res = subprocess.run(
            ["git", "show", f"{ref}:{path}"],
            capture_output=True,
            text=True,
            timeout=20,
        )
    except Exception:
        return None
    if res.returncode != 0:
        return None
    try:
        return _from_dict(json.loads(res.stdout))
    except Exception:
        return None


def merge(local, remote):
    base = _from_dict(remote) if remote is not None else _empty()
    m = {
        "posted": dict(base["posted"]),
        "feedback": dict(base["feedback"]),
        "query_stats": dict(base["query_stats"]),
        "cat_stats": dict(base["cat_stats"]),
        "tg": dict(base["tg"]),
        "recent": list(base["recent"]),
        "meta": dict(base["meta"]),
        "admin_ui": dict(base["admin_ui"]),
        "titles": dict(base["titles"]),
        "img_hash": dict(base["img_hash"]),
        "learned": dict(base["learned"]),
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
    for title, ts in (local.get("titles") or {}).items():
        if title not in m["titles"] or ts > m["titles"][title]:
            m["titles"][title] = ts
    for h, ts in (local.get("img_hash") or {}).items():
        if h not in m["img_hash"] or ts > m["img_hash"][h]:
            m["img_hash"][h] = ts
    for query, st in (local.get("learned") or {}).items():
        if query not in m["learned"] or st.get("ts", 0) > m["learned"][query].get(
            "ts", 0
        ):
            m["learned"][query] = st
    local_ui = local.get("admin_ui") or {}
    m["admin_ui"] = {"pending": local_ui.get("pending")}
    return m


def bump_meta(data, n=1):
    meta = data.setdefault("meta", {})
    today = time.strftime("%Y-%m-%d")
    if meta.get("today") != today:
        meta["today"] = today
        meta["today_posts"] = 0
    meta["today_posts"] = int(meta.get("today_posts", 0) or 0) + n
    meta["total_posts"] = int(meta.get("total_posts", 0) or 0) + n


def save(path, data):
    now = time.time()
    data["posted"] = {
        pid: ts
        for pid, ts in data["posted"].items()
        if now - ts < PRUNE_AFTER
    }
    keep = sorted(data["posted"].items(), key=lambda kv: kv[1])[-MAX_KEPT:]
    data["posted"] = dict(keep)
    data["titles"] = {
        title: ts
        for title, ts in data.get("titles", {}).items()
        if now - ts < PRUNE_AFTER
    }
    keep_titles = sorted(data["titles"].items(), key=lambda kv: kv[1])[-MAX_KEPT:]
    data["titles"] = dict(keep_titles)
    data["img_hash"] = {
        h: ts
        for h, ts in data.get("img_hash", {}).items()
        if now - ts < IMG_KEEP
    }
    keep_img = sorted(data["img_hash"].items(), key=lambda kv: kv[1])[-MAX_KEPT:]
    data["img_hash"] = dict(keep_img)
    data["learned"] = _norm_learned(data.get("learned") or {})
    data["learned"] = {
        q: st
        for q, st in data["learned"].items()
        if st["status"] != "retired" or now - st["ts"] < LEARNED_KEEP
    }
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