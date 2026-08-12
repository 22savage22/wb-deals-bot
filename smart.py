import random
import time


def _decay(stats):
    days = max(0, (time.time() - stats.get("ts", time.time())) / 86400)
    f = 0.9 ** days
    return {
        "posts": stats.get("posts", 0) * f,
        "likes": stats.get("likes", 0) * f,
        "dislikes": stats.get("dislikes", 0) * f,
        "bought": stats.get("bought", 0) * f,
        "ts": stats.get("ts", time.time()),
    }


def _touch(bucket, key):
    stats = bucket.get(key)
    if stats is None:
        stats = {"posts": 0, "likes": 0, "dislikes": 0, "bought": 0, "ts": time.time()}
        bucket[key] = stats
    else:
        stats = _decay(stats)
        bucket[key] = stats
    return stats


def record_post(data, query, cat):
    for key in (query, cat):
        s = _touch(data["cat_stats"] if key == cat else data["query_stats"], key)
        s["posts"] += 1
        s["ts"] = time.time()


def record_feedback(data, query, cat, action):
    for key in (query, cat):
        s = _touch(data["cat_stats"] if key == cat else data["query_stats"], key)
        s[action] += 1
        s["ts"] = time.time()


def score(stats):
    posts = stats.get("posts", 0)
    if posts == 0:
        return 0.5
    likes = stats.get("likes", 0)
    dislikes = stats.get("dislikes", 0)
    bought = stats.get("bought", 0)
    return (likes + 0.7 * bought + 1) / (posts + 2) - 0.4 * dislikes / (posts + 1)


def pick_queries(pool, stats, n):
    if not pool:
        return []
    n = min(n, len(pool))
    ordered = sorted(pool, key=lambda q: score(stats.get(q, {})), reverse=True)
    if n == 1:
        return ordered[:1]
    picks = ordered[: n - 1]
    rest = ordered[n - 1 :]
    if rest:
        picks.append(random.choice(rest))
    return picks


def cat_boost(cat, stats):
    s = stats.get(cat, {})
    if s.get("posts", 0) < 3:
        return 0.0
    if s.get("dislikes", 0) >= s.get("likes", 0):
        return -1.5
    return 2.0


def summary(query_stats, cat_stats, n=5):
    rows = []
    for name, table in (("Запросы", query_stats), ("Категории", cat_stats)):
        items = sorted(table.items(), key=lambda kv: score(kv[1]), reverse=True)[:n]
        rows.append(f"<b>{name}:</b>")
        for key, s in items:
            rows.append(
                f"  {key}: постов {s['posts']:.0f}, 👍 {s['likes']:.0f}, "
                f"👎 {s['dislikes']:.0f}, 🛒 {s['bought']:.0f}, рейтинг {score(s):.2f}"
            )
        if not items:
            rows.append("  пока нет данных")
    return "\n".join(rows)