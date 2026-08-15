import html
import logging
import os
import random
import subprocess
import sys
import time

import admin
import config
import gitutil
import log
import smart
import state
import tg
import wb

logger = logging.getLogger("wb.bot")


def _run(*args):
    res = subprocess.run(args, capture_output=True, text=True)
    if res.returncode != 0:
        print("git error:", " ".join(args), "->", res.returncode)
        print((res.stderr or res.stdout).strip()[:400])
    return res


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


def _img_dup(img_hash, h, now, repost_secs):
    if not h or not img_hash:
        return False
    for stored_h, stored_ts in img_hash.items():
        if now - stored_ts < repost_secs and wb.hamming(h, stored_h) <= config.HAMMING_MAX:
            return True
    return False


def _post_images(token, chat_id, images, caption, link, pid):
    if len(images) > 1:
        if tg.send_album(token, chat_id, images, caption, link, pid):
            return True
    return tg.send_photo(token, chat_id, images[0], caption, link, pid)


def run_posting(data, settings, notify=True):
    posted = data["posted"]
    pool = settings.get("queries") or config.QUERIES or config.DEFAULT_QUERIES
    queries = smart.pick_queries(
        pool, data["query_stats"], config.QUERIES_PER_RUN, data
    )

    meta = data.setdefault("meta", {})
    now = time.time()
    if not data.get("cats") or now - float(meta.get("cats_ts", 0) or 0) > 24 * 3600:
        try:
            smart.refresh_categories(data, wb.menu())
        except Exception:
            pass
        meta["cats_ts"] = now
    cat_names = smart.pick_categories(data, config.CATS_PER_RUN)

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

    meta["last_cats"] = list(cat_names)

    if not seen:
        smart.tally_cats(data, cat_names, {})
        print("Поиск не дал результатов")
        _notify_run(data, settings, queries, cat_names, 0, [], notify)
        return 0

    cards = wb.cards(list(seen.keys()))

    deals = []
    for card in cards:
        d = wb.deal(card)
        if d:
            deals.append(d)

    if not deals:
        for item in seen.values():
            d = wb.deal_from_search(item)
            if d:
                deals.append(d)

    repost_secs = config.REPOST_DAYS * 86400
    prices = data.setdefault("prices", {})
    allowed = []
    for d in deals:
        pid = d["id"]
        last = posted.get(pid)
        if last and now - last < repost_secs:
            if smart.price_drop(d, prices, config.PRICE_DROP_MIN):
                allowed.append(d)
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
            continue
        if titles.get(key) and now - titles[key] < repost_secs:
            continue
        seen_titles.add(key)
        unique.append(d)
    deals = unique
    for d in deals:
        if d.get("category", "другое") == "другое" and pid_query.get(d["id"]):
            d["category"] = pid_query[d["id"]]
    deals = smart.pick_deals(deals, data, config.MAX_POSTS)

    published = 0
    posted_deals = []
    img_hash = data.setdefault("img_hash", {})
    for deal in deals:
        if published >= config.MAX_POSTS:
            break
        pid = deal["id"]
        images = wb.photos(pid)
        if not images:
            state.record_error(data, f"Нет фото: {pid}")
            print("Нет фото:", pid)
            continue
        h = wb.image_hash(images[0])
        if h and not deal.get("price_drop") and _img_dup(img_hash, h, now, repost_secs):
            posted[pid] = int(now)
            print("Повтор по фото:", pid)
            continue
        link = config.LINK_TEMPLATE.format(nm=pid)
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

    data["meta"]["last_run"] = int(now)
    data["meta"]["last_posts"] = published
    data["meta"]["last_queries"] = list(queries)
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
        lines += [
            "",
            "Бот сам ротирует категории каталога WB — пустые уходят на паузу.",
        ]
        tg.send_message(token, admin, "\n".join(lines))


def process_updates(data, settings):
    events = admin.poll(config.TG_BOT_TOKEN, data)
    if not events:
        return
    changed = admin.handle_events(
        config.TG_BOT_TOKEN, config.TG_ADMIN_ID, data, settings, events
    )
    if changed:
        config.save_settings(settings)


def main():
    log.setup()
    if not config.TG_BOT_TOKEN or not config.TG_CHAT_ID:
        print("Задайте TG_BOT_TOKEN и TG_CHAT_ID")
        sys.exit(1)

    settings = config.load_settings()
    config.apply(settings)
    data = state.load(config.STATE_FILE)

    paused_until = settings.get("pause_until", 0) or 0
    manual = bool(settings.get("post_now_ts"))
    if paused_until > time.time() and not manual:
        print(
            "Постинг на паузе до",
            time.strftime("%Y-%m-%d %H:%M", time.localtime(paused_until)),
        )
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

    process_updates(data, settings)

    state.save(config.STATE_FILE, data)
    commit_state(config.STATE_FILE, data)

    print("Готово. Опубликовано:", data["meta"].get("last_posts", 0))


if __name__ == "__main__":
    if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    main()