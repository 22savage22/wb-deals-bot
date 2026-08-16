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
QUEUE_MAX = 100


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
        "prices": {},
        "cats": {},
        "queue": [],
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


def _norm_cats(raw):
    if not isinstance(raw, dict):
        return {}
    out = {}
    for name, st in raw.items():
        if not isinstance(name, str) or not name:
            continue
        if not isinstance(st, dict):
            continue
        try:
            shard = str(st.get("shard", "") or "")
            ts = float(st.get("ts", 0) or 0)
            runs = int(st.get("runs", 0) or 0)
            empty = int(st.get("empty", 0) or 0)
        except (TypeError, ValueError):
            continue
        out[name] = {"shard": shard, "ts": ts, "runs": runs, "empty": empty}
    return out


def _norm_prices(raw):
    if not isinstance(raw, dict):
        return {}
    now = time.time()
    out = {}
    for pid, p in raw.items():
        try:
            pid = int(pid)
        except (TypeError, ValueError):
            continue
        if not isinstance(p, dict):
            continue
        try:
            price = int(p.get("price", 0) or 0)
            basic = int(p.get("basic", 0) or 0)
            ts = float(p.get("ts", 0) or 0)
        except (TypeError, ValueError):
            continue
        if not price or now - ts >= PRUNE_AFTER:
            continue
        out[pid] = {"price": price, "basic": basic, "ts": ts}
    return out


def _norm_admin_ui(raw):
    if not isinstance(raw, dict):
        return {"pending": None}
    pending = raw.get("pending")
    if not isinstance(pending, str):
        pending = None
    return {"pending": pending}


def _norm_queue(raw):
    """Keep only complete, fresh queue entries and deduplicate by article."""
    if not isinstance(raw, list):
        return []
    now = time.time()
    out = {}
    for item in raw:
        if not isinstance(item, dict):
            continue
        try:
            pid = int(item.get("id"))
            queued_ts = int(item.get("queued_ts", 0) or 0)
            product = int(item.get("product", 0) or 0)
            basic = int(item.get("basic", 0) or 0)
            discount = int(item.get("discount", 0) or 0)
            rating = float(item.get("rating", 0) or 0)
            feedbacks = int(item.get("feedbacks", 0) or 0)
        except (TypeError, ValueError):
            continue
        if not pid or not product or not queued_ts or now - queued_ts >= 48 * 3600:
            continue
        clean = {
            "id": pid,
            "title": str(item.get("title") or "Товар Wildberries")[:300],
            "brand": str(item.get("brand") or "")[:150],
            "product": product,
            "basic": basic,
            "discount": discount,
            "benefit": max(0, int(item.get("benefit", basic - product) or 0)),
            "rating": rating,
            "feedbacks": feedbacks,
            "category": str(item.get("category") or "другое")[:200],
            "selection_mode": str(item.get("selection_mode") or "strict")[:30],
            "quality": str(item.get("quality") or "A")[:10],
            "query": str(item.get("query") or "")[:200],
            "queued_ts": queued_ts,
        }
        old = out.get(pid)
        if old is None or queued_ts > old["queued_ts"]:
            out[pid] = clean
    return sorted(out.values(), key=lambda x: x["queued_ts"], reverse=True)[:QUEUE_MAX]


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
        "prices": _norm_prices(data.get("prices")),
        "cats": _norm_cats(data.get("cats")),
        "queue": _norm_queue(data.get("queue")),
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
        "prices": dict(base["prices"]),
        "cats": dict(base["cats"]),
        "queue": list(base["queue"]),
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
    for pid, p in (local.get("prices") or {}).items():
        if pid not in m["prices"] or p.get("ts", 0) > m["prices"][pid].get("ts", 0):
            m["prices"][pid] = p
    for name, st in (local.get("cats") or {}).items():
        if name not in m["cats"] or st.get("ts", 0) > m["cats"][name].get("ts", 0):
            m["cats"][name] = st
    queued = {item["id"]: item for item in m.get("queue", [])}
    for item in local.get("queue", []):
        old = queued.get(item["id"])
        if old is None or item.get("queued_ts", 0) > old.get("queued_ts", 0):
            queued[item["id"]] = item
    m["queue"] = _norm_queue(
        [item for pid, item in queued.items() if pid not in m["posted"]]
    )
    local_ui = local.get("admin_ui") or {}
    m["admin_ui"] = {"pending": local_ui.get("pending")}
    return m


def record_error(data, msg):
    meta = data.setdefault("meta", {})
    errors = meta.setdefault("errors", [])
    if not isinstance(errors, list):
        errors = []
    errors = [e for e in errors if isinstance(e, dict)]
    errors.append({"ts": int(time.time()), "msg": str(msg)[:400]})
    meta["errors"] = errors[-20:]


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
    data["prices"] = {
        pid: p
        for pid, p in data.get("prices", {}).items()
        if now - p.get("ts", 0) < PRUNE_AFTER
    }
    keep_prices = sorted(
        data["prices"].items(), key=lambda kv: kv[1].get("ts", 0)
    )[-MAX_KEPT:]
    data["prices"] = dict(keep_prices)
    data["cats"] = {
        name: st
        for name, st in data.get("cats", {}).items()
        if now - st.get("ts", 0) < LEARNED_KEEP
    }
    data["queue"] = _norm_queue(data.get("queue") or [])
    data["queue"] = [
        item for item in data["queue"] if item["id"] not in data["posted"]
    ][:QUEUE_MAX]
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
