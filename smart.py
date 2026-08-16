import html
import random
import time

CAT_COOLDOWN_H = 12
CATS_RETIRE_EMPTY = 5
CATS_REACTIVATE_SECS = 14 * 86400
CATS_WEIGHT_MIN = 0.2

LEARNED_MAX = 30
TRIAL_ATTEMPTS = 5
DISCOVERY_CHANCE = 0.7
LEARN_CATEGORY_MIN_SCORE = 0.6
LEARN_CATEGORY_MIN_POSTS = 2

DISCOVERY_POOL = [
    "телефоны", "планшеты", "ноутбуки", "смарт-часы", "наушники", "колонки",
    "робот-пылесос", "пылесос", "кофемашина", "микроволновка", "холодильник",
    "стиральная машина", "телевизор", "монитор", "клавиатура", "компьютерная мышь",
    "кроссовки", "куртка", "платье", "джинсы", "футболка", "сумка", "рюкзак",
    "часы мужские", "духи", "косметика", "крем для лица", "маска для волос",
    "игрушки", "конструктор", "детская одежда", "постельное белье", "подушка",
    "посуда", "сковорода", "чайник", "тостер", "блендер", "утюг",
    "инструменты", "дрель", "аккумулятор", "зарядное устройство",
    "спортивный костюм", "гантели", "велосипед", "самокат",
    "автокресло", "коврик", "лампа", "светильник", "органайзер",
    "термокружка", "бутылка", "ковер", "зеркало", "настольная игра",
]


def norm_title(text):
    return "".join(ch for ch in str(text or "").lower() if ch.isalnum())


def price_drop(deal, prices, min_drop=0.15):
    """Цена упала на min_drop (15% по умолчанию) с момента прошлого поста?
    Если цена выросла — обновляем базовую линию, чтобы ловить будущие падения."""
    if not prices:
        return False
    base = prices.get(deal.get("id"))
    if not base or not base.get("price"):
        return False
    current = deal.get("product") or 0
    base_price = float(base["price"])
    if current <= 0 or base_price <= 0:
        return False
    if current >= base_price:
        if current > base_price:
            base["price"] = current
        return False
    if current / base_price > 1.0 - max(0.0, float(min_drop)):
        return False
    deal["price_drop"] = True
    deal["last_price"] = int(base_price)
    return True


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
        if key is None:
            continue
        s = _touch(data["cat_stats"] if key == cat else data["query_stats"], key)
        s["posts"] += 1
        s["ts"] = time.time()


def record_feedback(data, query, cat, action):
    for key in (query, cat):
        if key is None:
            continue
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


def pick_queries(pool, stats, n, data=None):
    if not pool:
        return []
    candidates = list(pool)
    for q in _learned_active(data):
        if q not in candidates:
            candidates.append(q)
    if not candidates:
        return []
    n = min(n, len(candidates))
    ordered = sorted(candidates, key=lambda q: score(stats.get(q, {})), reverse=True)
    if n == 1:
        return ordered[:1]
    picks = ordered[: n - 1]
    rest = ordered[n - 1 :]
    if rest:
        if len(candidates) > n:
            discovery = _discovery_candidate(data, pool)
            if discovery:
                picks.append(discovery)
                return picks
        picks.append(random.choice(rest))
    return picks


def _learned_active(data):
    if not data:
        return []
    learned = data.get("learned") or {}
    return [q for q, st in learned.items() if st.get("status") == "active"]


def _discovery_candidate(data, pool):
    """Один слот в запуске отдаём разведке: новый запрос или испытание."""
    if not data:
        return None
    learned = data.get("learned") or {}
    if len(learned) >= LEARNED_MAX:
        return None
    untried = [q for q in DISCOVERY_POOL if q not in pool and q not in learned]
    if untried and random.random() < DISCOVERY_CHANCE:
        return random.choice(untried)
    trials = [
        q
        for q, st in learned.items()
        if st.get("status") == "trial" and st.get("attempts", 0) < TRIAL_ATTEMPTS
    ]
    if trials:
        return random.choice(trials)
    return None


def tally_run(data, pool, used_queries, posts_by_query):
    """Учёт результатов разведки: посты -> в ротацию, пустота -> к списанию."""
    learned = data.setdefault("learned", {})
    now = time.time()
    for q in used_queries:
        if q in pool:
            continue
        if q not in DISCOVERY_POOL and q not in learned:
            continue
        st = learned.get(q)
        if st is None:
            st = {"ts": now, "attempts": 0, "posts": 0, "status": "trial"}
            learned[q] = st
        n = posts_by_query.get(q, 0)
        if n:
            st["posts"] = int(st.get("posts", 0)) + n
            st["status"] = "active"
            st["ts"] = now
        else:
            st["attempts"] = int(st.get("attempts", 0)) + 1
            if st["attempts"] >= TRIAL_ATTEMPTS:
                st["status"] = "retired"


def learn_categories(data, pool):
    """Раз в сутки: успешные категории становятся новыми запросами."""
    meta = data.setdefault("meta", {})
    now = time.time()
    if now - float(meta.get("learn_ts", 0) or 0) < 24 * 3600:
        return 0
    meta["learn_ts"] = now
    learned = data.setdefault("learned", {})
    ranked = sorted(
        data.get("cat_stats", {}).items(), key=lambda kv: score(kv[1]), reverse=True
    )
    added = 0
    for cat, s in ranked:
        if len(learned) >= LEARNED_MAX:
            break
        if s.get("posts", 0) < LEARN_CATEGORY_MIN_POSTS:
            continue
        if score(s) < LEARN_CATEGORY_MIN_SCORE:
            continue
        if cat == "другое" or cat in pool or cat in learned:
            continue
        learned[cat] = {
            "ts": now,
            "attempts": 0,
            "posts": int(s.get("posts", 0)),
            "status": "active",
        }
        added += 1
    return added


def learned_counts(data):
    learned = data.get("learned") or {}
    active = sum(1 for st in learned.values() if st.get("status") == "active")
    trials = sum(1 for st in learned.values() if st.get("status") == "trial")
    return active, trials


def cat_boost(cat, stats):
    s = stats.get(cat, {})
    if s.get("posts", 0) < 3:
        return 0.0
    if s.get("dislikes", 0) >= s.get("likes", 0):
        return -1.5
    return 2.0


def _cat_last_ts(data):
    last = {}
    for r in data.get("recent", []):
        cat = r.get("cat")
        ts = r.get("ts", 0)
        if cat:
            last[cat] = max(last.get(cat, 0), ts)
    return last


def _freshness(cat, last_cat, now):
    last = last_cat.get(cat, 0)
    if not last:
        return 0.0
    hours = (now - last) / 3600.0
    if hours >= CAT_COOLDOWN_H:
        return 0.0
    return (CAT_COOLDOWN_H - hours) / CAT_COOLDOWN_H


def _rejected(cat_stats, cat):
    s = cat_stats.get(cat, {})
    posts = s.get("posts", 0)
    dislikes = s.get("dislikes", 0)
    likes = s.get("likes", 0)
    return posts >= 3 and dislikes >= 3 and dislikes >= likes * 2


def pick_deals(deals, data, n):
    now = time.time()
    cat_stats = data.get("cat_stats", {})
    last_cat = _cat_last_ts(data)
    by_cat = {}
    for d in deals:
        by_cat.setdefault(d["category"], []).append(d)
    for cat in by_cat:
        by_cat[cat].sort(
            key=lambda d: (deal_score(d) + cat_boost(cat, cat_stats), d["benefit"]),
            reverse=True,
        )
    cats = [c for c in by_cat if not _rejected(cat_stats, c)]
    if not cats:
        cats = list(by_cat)
    cats.sort(
        key=lambda c: (_freshness(c, last_cat, now), -score(cat_stats.get(c, {})))
    )
    selected = []
    while len(selected) < n and cats:
        progressed = False
        for cat in cats:
            bucket = by_cat[cat]
            if bucket:
                selected.append(bucket.pop(0))
                progressed = True
                if len(selected) >= n:
                    break
        if not progressed:
            break
    return selected


def deal_score(deal):
    """Balance the visible discount with trust, usefulness and real savings."""
    rating = float(deal.get("rating", 0) or 0)
    feedbacks = max(0, int(deal.get("feedbacks", 0) or 0))
    benefit = max(0, int(deal.get("benefit", 0) or 0))
    trust = min(12.0, feedbacks ** 0.5 / 2.0)
    rating_bonus = max(-10.0, (rating - 4.0) * 12.0) if rating else -8.0
    savings = min(10.0, benefit / 1000.0)
    drop_bonus = 15.0 if deal.get("price_drop") else 0.0
    fallback_penalty = 4.0 if deal.get("selection_mode") == "smart_fallback" else 0.0
    return float(deal.get("discount", 0) or 0) + trust + rating_bonus + savings + drop_bonus - fallback_penalty


def refresh_categories(data, menu):
    """Сливает каталог WB в память: категории (name, shard) без потери статистики."""
    if not menu:
        return 0
    cats = data.setdefault("cats", {})
    added = 0
    for name, shard in menu:
        if not name or not isinstance(name, str):
            continue
        st = cats.get(name)
        if st is None:
            cats[name] = {"shard": str(shard or ""), "ts": 0, "runs": 0, "empty": 0}
            added += 1
        else:
            st["shard"] = str(shard or "") or st.get("shard", "")
    return added


def pick_categories(data, n):
    """Выбирает n категорий: реже пустые и проверенные, чаще успешные."""
    cats = (data or {}).get("cats") or {}
    if not cats or n <= 0:
        return []
    now = time.time()
    active = []
    retired = []
    for name, st in cats.items():
        if not isinstance(st, dict):
            continue
        empty = int(st.get("empty", 0) or 0)
        if empty >= CATS_RETIRE_EMPTY:
            retired.append(name)
            if now - float(st.get("ts", 0) or 0) >= CATS_REACTIVATE_SECS:
                st["empty"] = 0
                active.append(name)
        else:
            active.append(name)
    if not active:
        if not retired:
            return []
        names = sorted(retired, key=lambda x: cats[x].get("ts", 0))[:n]
        for nm in names:
            cats[nm]["empty"] = 0
        return names
    cat_stats = (data or {}).get("cat_stats") or {}
    pool = []
    for name in active:
        sc = score(cat_stats.get(name, {}))
        empty = int(cats[name].get("empty", 0) or 0)
        weight = max(CATS_WEIGHT_MIN, sc) * (0.5 ** empty)
        pool.append((name, weight))
    picks = []
    for _ in range(min(n, len(pool))):
        total = sum(w for _, w in pool)
        if total <= 0:
            break
        r = random.uniform(0, total)
        acc = 0
        for i, (name, w) in enumerate(pool):
            acc += w
            if r <= acc:
                picks.append(name)
                pool.pop(i)
                break
    return picks


def tally_cats(data, used, posts_by_name):
    """Учёт запусков категорий: пост сбрасывает счётчик пустоты, пусто — копит."""
    cats = data.setdefault("cats", {})
    now = time.time()
    for name in used:
        st = cats.get(name)
        if st is None or not isinstance(st, dict):
            continue
        st["runs"] = int(st.get("runs", 0) or 0) + 1
        st["ts"] = now
        if posts_by_name.get(name):
            st["empty"] = 0
        else:
            st["empty"] = int(st.get("empty", 0) or 0) + 1


def notice_ok(data, key, cooldown):
    meta = data.setdefault("meta", {})
    now = int(time.time())
    if now - int(meta.get(key, 0) or 0) < cooldown:
        return False
    meta[key] = now
    return True


def _votes_since(data, since):
    likes = dislikes = bought = 0
    for pid, fb in data.get("feedback", {}).items():
        if fb.get("ts", 0) < since:
            continue
        likes += fb.get("likes", 0)
        dislikes += fb.get("dislikes", 0)
        bought += fb.get("bought", 0)
    return likes, dislikes, bought


def _top_posts(data, since, n=3):
    items = []
    for r in data.get("recent", []):
        if r.get("ts", 0) < since:
            continue
        fb = data.get("feedback", {}).get(r["pid"])
        likes = (fb or {}).get("likes", 0)
        items.append((likes, r))
    items.sort(key=lambda x: x[0], reverse=True)
    out = []
    for likes, r in items[:n]:
        title = html.escape(str(r.get("title", "")))
        if len(title) > 42:
            title = title[:39] + "..."
        discount = r.get("discount", "?")
        link = r.get("link", "")
        row = f"   {discount}% · {title} · 👍 {likes}"
        if link:
            row += f" · <a href=\"{link}\">пост</a>"
        out.append(row)
    return out


def admin_digest(data):
    now = time.time()
    since = now - 86400
    posts = [r for r in data.get("recent", []) if r.get("ts", 0) >= since]
    likes, dislikes, bought = _votes_since(data, since)
    meta = data.get("meta", {})
    lines = [
        "📊 <b>Отчёт за сутки</b>",
        "",
        f"🆕 Постов: <b>{len(posts)}</b> · всего: {int(meta.get('total_posts', 0) or 0)}",
    ]
    if likes or dislikes or bought:
        lines.append(f"💬 Голосов: 👍 {likes} · 👎 {dislikes} · 🛒 {bought}")
    top = _top_posts(data, since, 3)
    if top:
        lines += ["", "🏆 <b>Топ за сутки:</b>"] + top
    if meta.get("last_queries"):
        lines += ["", "🔍 Последние запросы: " + ", ".join(str(q) for q in meta["last_queries"])]
    lines += ["", "Управление: /help"]
    return "\n".join(lines)


def week_digest(data):
    now = time.time()
    since = now - 7 * 86400
    posts = [r for r in data.get("recent", []) if r.get("ts", 0) >= since]
    likes, dislikes, bought = _votes_since(data, since)
    lines = [
        "📊 <b>Итоги недели</b>",
        "",
        f"🆕 За неделю опубликовано <b>{len(posts)}</b> находок",
    ]
    if likes or dislikes or bought:
        lines.append(f"💬 Вы поставили: 👍 <b>{likes}</b> · 👎 <b>{dislikes}</b> · 🛒 <b>{bought}</b>")
    top = _top_posts(data, since, 3)
    if top:
        lines += ["", "🏆 <b>Топ-3 по вашим лайкам:</b>"] + top
    lines += [
        "",
        "Спасибо, что выбираете лучшее вместе с нами! 💜",
        "#вайлдберриз #скидки #итоги",
    ]
    return "\n".join(lines)


def summary(query_stats, cat_stats, n=5):
    rows = []
    for name, table in (("Запросы", query_stats), ("Категории", cat_stats)):
        items = sorted(table.items(), key=lambda kv: score(kv[1]), reverse=True)[:n]
        rows.append(f"<b>{name}:</b>")
        for key, s in items:
            rows.append(
                f"  {html.escape(str(key))}: постов {s['posts']:.0f}, 👍 {s['likes']:.0f}, "
                f"👎 {s['dislikes']:.0f}, 🛒 {s['bought']:.0f}, рейтинг {score(s):.2f}"
            )
        if not items:
            rows.append("  пока нет данных")
    return "\n".join(rows)
