import html
import logging
import os
import random
import subprocess
import sys
import time
from datetime import datetime
from zoneinfo import ZoneInfo

import config
import deal_queue
import engagement
import gitutil
import log
import smart
import state
import tg
import wb

logger = logging.getLogger("wb.bot")

_ELECTRONICS_KEYWORDS = [
    "смартфон", "телефон", "iphone", "samsung", "xiaomi", "redmi", "realme",
    "наушники", "headphones", "airpods",
    "ноутбук", "laptop", "планшет", "tablet", "ipad",
    "монитор", "monitor", "телевизор", "tv",
    "колонка", "колонки", "speaker", "bluetooth", "сабвуфер",
    "зарядка", "charger", "кабель", "cable", "powerbank", "повербанк",
    "часы", "watch", "smartwatch", "умные часы",
    "чехол", "case", "стекло", "glass", "protect",
    "клавиатура", "keyboard", "мышь", "mouse", "webcam", "веб-камера",
    "флешка", "flash", "ssd", "hdd", "диск", "memory", "карта памяти",
    "роутер", "router", "модем", "modem", "wi-fi",
    "принтер", "print", "сканер",
    "пылесос", "vacuum", "робот-пылесос",
    "кондиционер", "обогреватель", "вентилятор",
    "стиральн", "сушилк", "посудомоечн",
    "холодильник", "морозил", "микроволнов",
]


def _is_electronics(title):
    low = str(title or "").lower()
    return any(kw in low for kw in _ELECTRONICS_KEYWORDS)


PROMO_MESSAGES = [
    "🔥 <b>Горячие скидки на Wildberries!</b>\n\n"
    "Не упусти шанс сэкономить — скидки до 70% на одежду, обувь и товары для дома.\n"
    "Заходи в каталог и выбирай лучшее!\n\n"
    "🛒 <a href=\"https://www.wildberries.ru\">Перейти в каталог</a>",

    "💡 <b>Лучшие находки дня</b>\n\n"
    "Каждый день мы ищем для тебя товары с максимальными скидками.\n"
    "Следи за каналом — не пропусти свой идеальный товар!\n\n"
    "🛒 <a href=\"https://www.wildberries.ru\">Wildberries</a>",

    "🏷️ <b>Скидки обновлены!</b>\n\n"
    "Новые товары со скидками 50%+ уже в каталоге.\n"
    "Проверяй — то, что ты искал, может быть уже здесь.\n\n"
    "🛒 <a href=\"https://www.wildberries.ru\">Смотреть все</a>",

    "🛍️ <b>Распродажа продолжается!</b>\n\n"
    "Одежда, обувь, аксессуары и товары для дома по лучшим ценам.\n"
    "Не откладывай покупки — скидки не вечны!\n\n"
    "🛒 <a href=\"https://www.wildberries.ru\">Перейти</a>",

    "⭐ <b>Топ товаров недели</b>\n\n"
    "Мы собрали лучшие предложения с максимальными скидками.\n"
    "Следи за каналом — каждый день новые находки!\n\n"
    "🛒 <a href=\"https://www.wildberries.ru\">Wildberries</a>",
]


def _send_promo(token, chat_id):
    import random as _rand
    msg = _rand.choice(PROMO_MESSAGES)
    return tg.send_message(token, chat_id, msg)


def active_posting_time(now=None):
    """Return whether scheduled posting is enabled for the current hour."""
    current = now or datetime.now(ZoneInfo("Europe/Moscow"))
    return config.ACTIVE_HOUR_START <= current.hour <= config.ACTIVE_HOUR_END


def post_interval_elapsed(data, now=None, interval=10 * 60):
    last = max((int(r.get("ts", 0) or 0) for r in data.get("recent") or []), default=0)
    return (time.time() if now is None else now) - last >= interval


def _run(*args):
    res = subprocess.run(args, capture_output=True, text=True)
    if res.returncode != 0:
        print("git error:", " ".join(args), "->", res.returncode)
        print((res.stderr or res.stdout).strip()[:400])
    return res


def _link(pid):
    """Безопасная ссылка на товар: не даём кривому шаблону уронить бота."""
    try:
        return config.LINK_TEMPLATE.format(nm=pid)
    except (KeyError, IndexError, ValueError):
        return f"https://www.wildberries.ru/catalog/{pid}/detail.aspx"


def commit_state(path, data):
    def merge_fn(remote):
        return state.merge(data, remote)

    return gitutil.commit(path, merge_fn, "chore: update state")


def commit_settings(path, settings):
    def merge_fn(remote):
        if not isinstance(remote, dict):
            return settings
        if remote.get("mtime", 0) > settings.get("mtime", 0):
            return remote
        return settings

    return gitutil.commit(path, merge_fn, "chore: update settings")


def commit_queue(path, queue, posted):
    return gitutil.commit(
        path,
        lambda remote: deal_queue.merge(queue, remote, posted),
        "chore: update deal queue",
    )


def _img_dup(img_hash, h, now, repost_secs):
    if not h or not img_hash:
        return False
    for stored_h, stored_ts in img_hash.items():
        if now - stored_ts < repost_secs and wb.hamming(h, stored_h) <= config.HAMMING_MAX:
            return True
    return False


def _post_images(token, chat_id, images, caption, link, pid):
    if config.USE_ALBUMS and len(images) > 1:
        if tg.send_album(token, chat_id, images, caption, link, pid):
            return True
    return tg.send_photo(token, chat_id, images[0], caption, link, pid)


def _candidate_cards(cards, seen):
    """Prefer detailed cards, but keep search results missing from cards API."""
    by_id = {c.get("id"): c for c in cards if c.get("id")}
    for pid, item in seen.items():
        by_id.setdefault(pid, item)
    return list(by_id.values())


def _find_deals(candidates, limit, funnel):
    strict = []
    rejected = []
    for card in candidates:
        deal, reason = wb.evaluate(card)
        funnel[reason] = funnel.get(reason, 0) + 1
        if deal:
            deal["quality"] = "A"
            strict.append(deal)
        else:
            rejected.append(card)

    fallback = []
    if config.SMART_FALLBACK and len(strict) < limit:
        for card in rejected:
            deal, _ = wb.evaluate(
                card,
                min_discount=min(config.MIN_DISCOUNT, config.FALLBACK_MIN_DISCOUNT),
                min_rating=min(config.MIN_RATING, config.FALLBACK_MIN_RATING),
                min_feedbacks=config.FALLBACK_MIN_FEEDBACKS,
            )
            if deal:
                deal["selection_mode"] = "smart_fallback"
                deal["quality"] = "B"
                fallback.append(deal)
    reserve = []
    if config.SMART_FALLBACK and len(strict) + len(fallback) < limit:
        fallback_ids = {d["id"] for d in fallback}
        for card in rejected:
            if card.get("id") in fallback_ids:
                continue
            deal, _ = wb.evaluate(
                card,
                min_discount=config.RESERVE_MIN_DISCOUNT,
                min_rating=config.RESERVE_MIN_RATING,
                min_feedbacks=config.RESERVE_MIN_FEEDBACKS,
            )
            if deal:
                deal["selection_mode"] = "quality_reserve"
                deal["quality"] = "C"
                reserve.append(deal)
    funnel["strict"] = len(strict)
    funnel["fallback"] = len(fallback)
    funnel["reserve"] = len(reserve)
    return strict + fallback + reserve


def _funnel_text(funnel):
    labels = (
        ("found", "WB нашёл"),
        ("cards", "карточек"),
        ("strict", "прошли строго"),
        ("fallback", "умный резерв"),
        ("reserve", "качественный запас"),
        ("repost", "недавний повтор"),
        ("title_duplicate", "похожее название"),
        ("photo_duplicate", "похожее фото"),
        ("no_photo", "без фото"),
        ("selected", "отобрано"),
    )
    return " · ".join(f"{label}: {int(funnel.get(key, 0))}" for key, label in labels)


def _publish_queued(data, limit):
    """Publish pre-vetted deals; broken entries are discarded and backups tried."""
    now = time.time()
    repost_secs = config.REPOST_DAYS * 86400
    queue = list(data.get("queue") or [])
    published = 0
    posted_deals = []
    funnel = {"queue_before": len(queue), "selected": 0}
    posted = data["posted"]
    titles = data.setdefault("titles", {})
    prices = data.setdefault("prices", {})
    img_hash = data.setdefault("img_hash", {})

    while queue and published < limit:
        ordered = smart.balance_audience(queue, data, 1, published)
        if not ordered:
            break
        deal = ordered[0]
        queue.remove(deal)
        pid = deal["id"]
        if now - deal.get("queued_ts", 0) >= config.QUEUE_MAX_AGE_HOURS * 3600:
            funnel["expired"] = funnel.get("expired", 0) + 1
            continue
        if pid in posted:
            funnel["repost"] = funnel.get("repost", 0) + 1
            continue
        key = smart.norm_title(deal.get("title", ""))
        if key and titles.get(key) and now - titles[key] < repost_secs:
            funnel["title_duplicate"] = funnel.get("title_duplicate", 0) + 1
            continue
        if _is_electronics(deal.get("title", "")):
            funnel["electronics"] = funnel.get("electronics", 0) + 1
            continue
        images = wb.photos(pid)
        if len(images) < 2:
            funnel["no_photo"] = funnel.get("no_photo", 0) + 1
            state.record_error(data, f"Мало фото ({len(images)}): {pid}")
            print("Мало фото:", pid, len(images))
            continue
        h = wb.image_hash(images[0])
        if h and _img_dup(img_hash, h, now, repost_secs):
            funnel["photo_duplicate"] = funnel.get("photo_duplicate", 0) + 1
            posted[pid] = int(now)
            continue
        link = _link(pid)
        try:
            ok = _post_images(
                config.TG_BOT_TOKEN,
                config.TG_CHAT_ID,
                images,
                tg.caption(deal, pid),
                link,
                pid,
            )
        except Exception as exc:
            ok = False
            state.record_error(data, f"Очередь: ошибка публикации {pid}: {exc}")
        if not ok:
            funnel["send_failed"] = funnel.get("send_failed", 0) + 1
            detail = tg.last_error() if hasattr(tg, "last_error") else ""
            state.record_error(data, f"Telegram не принял {pid}: {detail or 'без описания'}")
            continue

        posted[pid] = int(now)
        if h:
            img_hash[h] = int(now)
        prices[pid] = {"price": deal["product"], "basic": deal["basic"], "ts": now}
        if key:
            titles[key] = int(now)
        published += 1
        funnel["selected"] += 1
        posted_deals.append(deal)
        data["recent"].append(
            {
                "pid": pid,
                "title": deal["title"],
                "discount": deal["discount"],
                "price": deal["product"],
                "rating": deal["rating"],
                "link": link,
                "query": deal.get("query"),
                "cat": deal["category"],
                "ts": int(now),
                "drop": int(deal.get("price_drop") or 0),
                "quality": deal.get("quality", "A"),
            }
        )
        smart.record_post(data, deal.get("query"), deal["category"])
        print("Опубликовано из очереди:", pid, f"{deal['discount']}%", deal["title"][:50])

    data["queue"] = queue
    funnel["queue_after"] = len(queue)
    return published, posted_deals, funnel


def run_posting(data, settings, notify=True):
    meta = data.setdefault("meta", {})
    now = time.time()
    meta["last_run"] = int(now)
    meta["last_posts"] = 0
    if data.get("queue"):
        published, queued_deals, queue_funnel = _publish_queued(data, config.MAX_POSTS)
        meta["queue_size"] = len(data.get("queue") or [])
        meta["last_queue"] = queue_funnel
        if published:
            meta["last_posts"] = published
            meta["last_funnel"] = {"published": published, "selected": published}
            state.bump_meta(data, published)
            queries = [d.get("query") for d in queued_deals if d.get("query")]
            cats = [d.get("category") for d in queued_deals if d.get("category")]
            _notify_run(data, settings, queries, cats, published, queued_deals, notify)
            return published

    wb.reset_health()
    posted = data["posted"]
    pool = settings.get("queries") or config.QUERIES or config.DEFAULT_QUERIES
    if isinstance(pool, str):
        pool = [q.strip() for q in pool.split(",") if q.strip()]
    queries = smart.pick_queries(
        pool, data["query_stats"], config.QUERIES_PER_RUN, data
    )

    meta["last_queries"] = list(queries)
    funnel = {"found": 0, "cards": 0}
    if not data.get("cats") or now - float(meta.get("cats_ts", 0) or 0) > 24 * 3600:
        try:
            menu = wb.menu()
            if menu:
                smart.refresh_categories(data, menu)
                meta["cats_ts"] = now
                meta["cats_count"] = len(data.get("cats") or {})
            else:
                state.record_error(data, "Каталог категорий WB вернул пустой ответ")
        except Exception as exc:
            state.record_error(data, f"Не удалось обновить каталог категорий WB: {exc}")
    cat_names = smart.pick_categories(data, config.CATS_PER_RUN)
    meta["last_cats"] = list(cat_names)

    seen = {}
    pid_query = {}
    for query in queries:
        for page in range(1, config.PAGES + 1):
            items = wb.search(query, page)
            if not items:
                break
            for item in items:
                pid = item.get("id")
                if pid and pid not in seen:
                    seen[pid] = item
                    pid_query[pid] = query
            time.sleep(random.uniform(2.0, 4.0))
        time.sleep(random.uniform(3.0, 6.0))
    for name in cat_names:
        shard = (data.get("cats") or {}).get(name, {}).get("shard") or ""
        for page in range(1, config.PAGES + 1):
            items = wb.search(name, page, subject=shard or None)
            if not items:
                break
            for item in items:
                pid = item.get("id")
                if pid and pid not in seen:
                    seen[pid] = item
                    pid_query[pid] = name
            time.sleep(random.uniform(2.0, 4.0))
        time.sleep(random.uniform(3.0, 6.0))

    if not wb.search_healthy():
        state.record_error(data, "WB API вернул неожиданный формат ответа")
        if (
            config.TG_ADMIN_ID
            and smart.notice_ok(data, "api_fail_notice_ts", 24 * 3600)
        ):
            tg.send_message(
                config.TG_BOT_TOKEN,
                config.TG_ADMIN_ID,
                "⚠️ <b>Wildberries изменил формат ответа</b> — бот может "
                "ничего не находить. Проверь wb.py, пока данные не потерялись.",
            )

    funnel["found"] = len(seen)

    if not seen:
        meta["wb_http"] = wb.health_snapshot()
        meta["last_funnel"] = funnel
        smart.tally_run(data, pool, queries, {})
        smart.tally_cats(data, cat_names, {})
        if engagement.should_post_engagement(data):
            print("WB пуст, отправляю engagement-пост")
            engagement.post_engagement(data)
        else:
            print("WB пуст, отправляю промо")
            _send_promo(config.TG_BOT_TOKEN, config.TG_CHAT_ID)
        _notify_run(data, settings, queries, cat_names, 0, [], notify)
        return 0

    cards = wb.cards(list(seen.keys()))
    candidates = _candidate_cards(cards, seen)
    funnel["cards"] = len(candidates)
    deals = _find_deals(candidates, config.MAX_POSTS, funnel)

    repost_secs = config.REPOST_DAYS * 86400
    prices = data.setdefault("prices", {})
    allowed = []
    for d in deals:
        pid = d["id"]
        if pid in posted:
            if smart.price_drop(d, prices, config.PRICE_DROP_MIN):
                allowed.append(d)
            else:
                funnel["repost"] = funnel.get("repost", 0) + 1
            continue
        allowed.append(d)
    deals = allowed
    titles = data.setdefault("titles", {})
    seen_titles = set()
    unique = []
    for d in sorted(deals, key=lambda x: (x["discount"], x["benefit"]), reverse=True):
        if d.get("price_drop"):
            unique.append(d)
            continue
        key = smart.norm_title(d["title"])
        if not key:
            unique.append(d)
            continue
        if key in seen_titles:
            funnel["title_duplicate"] = funnel.get("title_duplicate", 0) + 1
            continue
        if titles.get(key) and now - titles[key] < repost_secs:
            funnel["title_duplicate"] = funnel.get("title_duplicate", 0) + 1
            continue
        if _is_electronics(d.get("title", "")):
            funnel["electronics"] = funnel.get("electronics", 0) + 1
            continue
        seen_titles.add(key)
        unique.append(d)
    deals = unique
    for d in deals:
        d["query"] = pid_query.get(d["id"]) or ""
        if d.get("category", "другое") == "другое" and pid_query.get(d["id"]):
            d["category"] = pid_query[d["id"]]
    # Keep backup candidates: a broken image or one rejected Telegram upload
    # must not turn the whole scheduled run into zero posts.
    attempt_limit = max(config.MAX_POSTS + 2, config.MAX_POSTS * 5)
    deals = smart.pick_deals(deals, data, attempt_limit)
    funnel["selected"] = len(deals)

    published = 0
    posted_deals = []
    img_hash = data.setdefault("img_hash", {})
    while deals and published < config.MAX_POSTS:
        ordered = smart.balance_audience(deals, data, 1, published)
        if not ordered:
            break
        deal = ordered[0]
        deals.remove(deal)
        pid = deal["id"]
        images = wb.photos(pid)
        if len(images) < 2:
            funnel["no_photo"] = funnel.get("no_photo", 0) + 1
            state.record_error(data, f"Мало фото ({len(images)}): {pid}")
            print("Мало фото:", pid, len(images))
            continue
        h = wb.image_hash(images[0])
        if h and not deal.get("price_drop") and _img_dup(img_hash, h, now, repost_secs):
            funnel["photo_duplicate"] = funnel.get("photo_duplicate", 0) + 1
            # Remember the rejected article so the same catalogue duplicate is
            # not downloaded and reconsidered on every scheduled run.
            posted[pid] = int(now)
            print("Повтор по фото:", pid)
            continue
        link = _link(pid)
        try:
            ok = _post_images(
                config.TG_BOT_TOKEN,
                config.TG_CHAT_ID,
                images,
                tg.caption(deal, pid),
                link,
                pid,
            )
        except Exception as exc:
            state.record_error(data, f"Ошибка публикации {pid}: {exc}")
            print("Ошибка публикации:", pid, exc)
            ok = False
        if not ok:
            funnel["send_failed"] = funnel.get("send_failed", 0) + 1
            detail = tg.last_error() if hasattr(tg, "last_error") else ""
            state.record_error(data, f"Telegram не принял {pid}: {detail or 'без описания'}")
        elif hasattr(tg, "last_error") and tg.last_error():
            state.record_error(data, f"Пост {pid} отправлен, но кнопки не добавились: {tg.last_error()}")
        if ok:
            posted[pid] = int(now)
            if h and not deal.get("price_drop"):
                img_hash[h] = int(now)
            prices[pid] = {
                "price": deal["product"],
                "basic": deal["basic"],
                "ts": now,
            }
            key = smart.norm_title(deal["title"])
            if key:
                titles[key] = int(now)
            published += 1
            posted_deals.append(deal)
            data["recent"].append(
                {
                    "pid": pid,
                    "title": deal["title"],
                    "discount": deal["discount"],
                    "price": deal["product"],
                    "rating": deal["rating"],
                    "link": link,
                    "query": pid_query.get(pid),
                    "cat": deal["category"],
                    "ts": int(now),
                    "drop": int(deal.get("price_drop") or 0),
                }
            )
            smart.record_post(data, pid_query.get(pid), deal["category"])
            print("Опубликовано:", pid, f"{deal['discount']}%", deal["title"][:50])
        time.sleep(1.5)

    data["meta"]["last_posts"] = published
    funnel["published"] = published
    data["meta"]["last_funnel"] = funnel
    data["meta"]["wb_http"] = wb.health_snapshot()
    if published:
        state.bump_meta(data, published)
    posts_by_query = {}
    for d in posted_deals:
        q = pid_query.get(d["id"])
        if q:
            posts_by_query[q] = posts_by_query.get(q, 0) + 1
    smart.tally_run(data, pool, queries, posts_by_query)
    posts_by_cat = {}
    for d in posted_deals:
        q = pid_query.get(d["id"])
        if q in cat_names:
            posts_by_cat[q] = posts_by_cat.get(q, 0) + 1
    smart.tally_cats(data, cat_names, posts_by_cat)
    added = smart.learn_categories(data, pool)
    if added:
        print("Новые запросы из категорий:", added)
    parts = ["Запросы: " + ", ".join(queries)]
    if cat_names:
        parts.append("Категории: " + ", ".join(cat_names))
    print(" · ".join(parts))
    if published and engagement.should_post_engagement(data, interval_hours=4):
        if random.random() < 0.35:
            engagement.post_engagement(data)
    _notify_run(data, settings, queries, cat_names, published, posted_deals, notify)
    return published


def _notify_run(data, settings, queries, cat_names, published, posted_deals, notify):
    admin = config.TG_ADMIN_ID
    token = config.TG_BOT_TOKEN
    if not notify or not admin:
        return
    if published:
        top = max(posted_deals, key=lambda d: d["discount"])
        title = html.escape(top["title"])
        if len(title) > 60:
            title = title[:57] + "..."
        tg.send_message(
            token,
            admin,
            "\n".join(
                [
                    "🚀 <b>Запуск завершён</b>",
                    "",
                    f"📦 Опубликовано: <b>{published}</b>",
                    f"🔥 Топ: <b>{top['discount']}%</b> · {title}",
                ]
            ),
        )
        return
    if smart.notice_ok(data, "empty_notice_ts", 12 * 3600):
        lines = ["😴 <b>Запуск ничего не нашёл</b>", ""]
        if queries:
            lines.append("Запросы: " + ", ".join(str(q) for q in queries))
        if cat_names:
            lines.append("Категории: " + ", ".join(str(c) for c in cat_names))
        funnel = data.get("meta", {}).get("last_funnel") or {}
        lines.append("Воронка: " + _funnel_text(funnel))
        lines += [
            "",
            "Пустые категории временно снижаются в ротации; хорошие возвращаются чаще.",
        ]
        tg.send_message(token, admin, "\n".join(lines))


def main():
    log.setup()
    if not config.TG_BOT_TOKEN or not config.TG_CHAT_ID:
        print("Задайте TG_BOT_TOKEN и TG_CHAT_ID")
        sys.exit(1)

    settings = config.load_settings()
    config.apply(settings)
    data = state.load(config.STATE_FILE)
    data["queue"] = deal_queue.load(config.QUEUE_FILE)

    paused_until = settings.get("pause_until", 0) or 0
    manual = bool(settings.get("post_now_ts"))
    forced = manual or bool(config.FORCE_POST)
    if not active_posting_time() and not forced:
        print(
            "Постинг вне настроенного окна:",
            f"{config.ACTIVE_HOUR_START:02d}:00–{config.ACTIVE_HOUR_END:02d}:59",
        )
    elif paused_until > time.time() and not forced:
        print(
            "Постинг на паузе до",
            time.strftime("%Y-%m-%d %H:%M", time.localtime(paused_until)),
        )
    elif not forced and not post_interval_elapsed(data):
        print("10 минут с последнего поста ещё не прошло")
    else:
        try:
            run_posting(data, settings)
        except Exception as exc:
            state.record_error(data, f"Запуск упал: {exc}")
            logger.error("Запуск упал: %s", exc)
            print("Ошибка постинга:", exc)
            if config.TG_ADMIN_ID:
                try:
                    tg.send_message(
                        config.TG_BOT_TOKEN,
                        config.TG_ADMIN_ID,
                        "❌ <b>Запуск упал:</b>\n<code>"
                        + html.escape(str(exc)[:400])
                        + "</code>",
                    )
                except Exception:
                    pass

    if settings.get("post_now_ts"):
        settings.pop("post_now_ts", None)
        settings.pop("post_lock", None)
        config.save_settings(settings)

    data["queue"] = deal_queue.save(
        config.QUEUE_FILE, data.get("queue") or [], data.get("posted") or {}
    )
    commit_queue(config.QUEUE_FILE, data["queue"], data.get("posted") or {})
    state.save(config.STATE_FILE, data)
    commit_state(config.STATE_FILE, data)

    print("Готово. Опубликовано:", data["meta"].get("last_posts", 0))


if __name__ == "__main__":
    if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    main()
