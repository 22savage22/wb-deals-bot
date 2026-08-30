"""Background catalogue scanner that keeps a ready-to-publish deal queue."""

import logging
import random
import sys
import time

import bot
import config
import deal_queue
import log
import smart
import state
import wb

logger = logging.getLogger("wb.scanner")


def _eligible_category(name):
    low = str(name or "").lower()
    return bool(low) and not any(word in low for word in config.CATEGORY_BLOCKLIST)


def _pool(settings):
    pool = settings.get("queries") or config.QUERIES or config.DEFAULT_QUERIES
    if isinstance(pool, str):
        pool = [q.strip() for q in pool.split(",") if q.strip()]
    return pool


def _limit_topics(items, limit=3):
    counts = {}
    selected = []
    for item in items:
        topic = smart._topic(item)
        if counts.get(topic, 0) >= limit:
            continue
        counts[topic] = counts.get(topic, 0) + 1
        selected.append(item)
    return selected


def fill_queue(data, settings, target=None):
    """Scan rotating searches/categories and add diverse validated deals."""
    target = max(1, int(target or config.QUEUE_TARGET))
    now = time.time()
    posted = data["posted"]
    disabled = bot._disabled_topics(settings)
    queue = [
        item
        for item in data.get("queue", [])
        if item["id"] not in posted
        and now - item.get("queued_ts", 0) < config.QUEUE_MAX_AGE_HOURS * 3600
        and smart._topic(item) not in disabled
    ]
    if len(queue) > target:
        queue = _limit_topics(queue)
        queue = smart.balance_audience(queue, data, target, allow_fallback=False)
    data["queue"] = queue
    if len(queue) >= target:
        data.setdefault("meta", {})["queue_size"] = len(queue)
        print(f"Очередь уже заполнена: {len(queue)}/{target}")
        return 0

    wb.reset_health()
    pool = [q for q in _pool(settings) if str(q).strip().lower() not in disabled]
    queries = smart.pick_queries(pool, data["query_stats"], config.QUERIES_PER_RUN, data)
    meta = data.setdefault("meta", {})
    meta["last_scan"] = int(now)
    meta["last_scan_queries"] = list(queries)
    funnel = {"found": 0, "cards": 0}

    if not data.get("cats") or now - float(meta.get("cats_ts", 0) or 0) > 24 * 3600:
        try:
            menu = wb.menu()
            if menu:
                menu = [(name, shard) for name, shard in menu if _eligible_category(name)]
                smart.refresh_categories(data, menu)
                meta["cats_ts"] = now
                meta["cats_count"] = len(data.get("cats") or {})
            else:
                state.record_error(data, "Сканер: каталог категорий WB вернул пустой ответ")
        except Exception as exc:
            state.record_error(data, f"Сканер: не удалось обновить категории: {exc}")

    cat_names = [
        name for name in smart.pick_categories(data, config.CATS_PER_RUN)
        if _eligible_category(name) and str(name).strip().lower() not in disabled
    ]
    meta["last_scan_cats"] = list(cat_names)
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
            time.sleep(random.uniform(1.5, 3.0))
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
            time.sleep(random.uniform(1.5, 3.0))

    funnel["found"] = len(seen)
    cards = wb.cards(list(seen.keys())) if seen else []
    candidates = bot._candidate_cards(cards, seen)
    funnel["cards"] = len(candidates)
    need = target - len(queue)
    deals = bot._find_deals(candidates, need, funnel)

    queued_ids = {item["id"] for item in queue}
    recent_titles = data.setdefault("titles", {})
    repost_secs = config.REPOST_DAYS * 86400
    eligible = []
    run_titles = {
        smart.norm_title(item.get("title", "")) for item in queue
        if smart.norm_title(item.get("title", ""))
    }
    for deal in sorted(deals, key=smart.deal_score, reverse=True):
        pid = deal["id"]
        if pid in queued_ids or pid in posted:
            funnel["duplicate"] = funnel.get("duplicate", 0) + 1
            continue
        title_key = smart.norm_title(deal["title"])
        if title_key in run_titles or (
            recent_titles.get(title_key) and now - recent_titles[title_key] < repost_secs
        ):
            funnel["title_duplicate"] = funnel.get("title_duplicate", 0) + 1
            continue
        if bot._is_electronics(deal.get("title", "")):
            funnel["electronics"] = funnel.get("electronics", 0) + 1
            continue
        run_titles.add(title_key)
        if deal.get("category", "другое") == "другое" and pid_query.get(pid):
            deal["category"] = pid_query[pid]
        deal["query"] = pid_query.get(pid) or ""
        deal["queued_ts"] = int(now)
        if smart._topic(deal) in disabled:
            continue
        eligible.append(deal)

    # Diversity selection avoids a buffer filled with near-identical products.
    ranked = smart.pick_deals(eligible, data, max(need * 3, need))
    selected = smart.balance_audience(ranked, data, need, topic_limit=3)
    queue.extend(selected)
    data["queue"] = queue
    meta["queue_size"] = len(queue)
    meta["last_scan_added"] = len(selected)
    meta["last_scan_funnel"] = funnel
    meta["wb_http"] = wb.health_snapshot()
    smart.tally_run(data, pool, queries, {})
    smart.tally_cats(data, cat_names, {})
    print(f"Сканирование завершено: добавлено {len(selected)}, в очереди {len(queue)}/{target}")
    return len(selected)


def main():
    log.setup()
    settings = config.load_settings()
    config.apply(settings)
    data = state.load(config.STATE_FILE)
    data["queue"] = deal_queue.load(config.QUEUE_FILE)
    before_ids = {item["id"] for item in data["queue"]}
    try:
        fill_queue(data, settings)
    except Exception as exc:
        state.record_error(data, f"Сканер упал: {exc}")
        logger.exception("Сканер упал")
    data["queue"] = deal_queue.save(
        config.QUEUE_FILE, data.get("queue") or [], data.get("posted") or {}
    )
    removed = before_ids - {item["id"] for item in data["queue"]}
    bot.commit_queue(
        config.QUEUE_FILE, data["queue"], data.get("posted") or {}, removed
    )
    state.save(config.STATE_FILE, data)
    bot.commit_state(config.STATE_FILE, data)


if __name__ == "__main__":
    if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    main()
