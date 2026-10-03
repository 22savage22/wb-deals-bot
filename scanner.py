"""Background catalogue scanner that keeps a ready-to-publish deal queue."""

import logging
import random
import sys
import time
from datetime import datetime
from zoneinfo import ZoneInfo

import bot
import config
import deal_queue
import log
import smart
import state
import wb
import scheduling
import scheduler_client

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


def fill_queue(data, settings, target=None, force_scan=False, deadline=None):
    """Scan rotating searches/categories and add diverse validated deals."""
    scheduled = scheduler_client.enabled()
    schedule = scheduling.normalize(settings)
    target = max(1, min(300, int(target or (schedule["min_queue"] if scheduled else config.QUEUE_TARGET))))
    if scheduled and deadline is None:
        deadline = time.monotonic() + 360
    now = time.time()
    posted = data["posted"]
    disabled = bot._disabled_topics(settings)
    queue = [
        item
        for item in data.get("queue", [])
        if item["id"] not in posted
        and now - item.get("queued_ts", 0) < (72 if scheduled else config.QUEUE_MAX_AGE_HOURS) * 3600
        and smart._topic(item) not in disabled
    ]
    # A nominally full buffer can be entirely unpublishable after daily caps.
    # Bound EACH topic even in scheduled mode, before the early-return check.
    queue = _limit_topics(queue, smart.DAILY_TOPIC_LIMIT)
    if len(queue) > target:
        queue = smart.balance_audience(queue, data, target, allow_fallback=False)
    data["queue"] = queue
    if len(queue) >= target and not force_scan:
        data.setdefault("meta", {})["queue_size"] = len(queue)
        print(f"Очередь уже заполнена: {len(queue)}/{target}")
        return 0

    wb.reset_health()
    pool = [q for q in _pool(settings) if str(q).strip().lower() not in disabled]
    queries = smart.pick_queries(pool, data["query_stats"], config.QUERIES_PER_RUN, data)
    meta = data.setdefault("meta", {})
    meta["last_scan"] = int(now)
    meta["last_scan_attempt"] = int(now)
    meta["last_scan_queries"] = list(queries)
    funnel = {"found": 0, "cards": 0}
    old_seen = state._norm_discovery(meta.get("discovery_seen"))
    known = set(old_seen) | set(posted) | {item["id"] for item in queue}
    page_start = 1 + int(meta.get("scan_page_cursor", 0) or 0) % max(1, config.PAGES) if scheduled else 1
    pages = list(range(page_start, config.PAGES + 1)) + list(range(1, page_start))
    if scheduled:
        meta["scan_page_cursor"] = page_start % max(1, config.PAGES)

    def expired():
        return deadline is not None and time.monotonic() >= deadline

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
        if expired():
            break
        for page in pages:
            if expired():
                break
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
        if expired():
            break
        shard = (data.get("cats") or {}).get(name, {}).get("shard") or ""
        for page in pages:
            if expired():
                break
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
    new_ids = set(seen) - known
    funnel["already_known"] = len(seen) - len(new_ids)
    funnel["new"] = len(new_ids)
    cards = []
    if scheduled:
        # Live search cards are usable; enrich while budget remains. Publisher
        # revalidates the selected batch again immediately before Telegram send.
        ids = [pid for pid in seen if pid not in posted and pid not in {item["id"] for item in queue}]
        ids = ids[:min(600, max(0, target - len(queue)) * 3)]
        for start in range(0, len(ids), 20):
            if expired():
                break
            cards.extend(wb.cards(ids[start:start + 20]))
    elif seen:
        cards = wb.cards(list(seen.keys()))
    candidates = bot._candidate_cards(cards, seen)
    funnel["cards"] = len(candidates)
    need = max(0, target - len(queue))
    deals = bot._find_deals(candidates, need, funnel, data.setdefault("prices", {}))

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
    topic_counts = {}
    for item in queue:
        topic = smart._topic(item)
        topic_counts[topic] = topic_counts.get(topic, 0) + 1
    diverse = []
    for item in eligible:
        topic = smart._topic(item)
        if topic_counts.get(topic, 0) >= smart.DAILY_TOPIC_LIMIT:
            continue
        topic_counts[topic] = topic_counts.get(topic, 0) + 1
        diverse.append(item)
    ranked = smart.pick_deals(diverse, data, max(need * 3, need))
    # Daily posting caps must not prevent a multi-day inventory from filling.
    selected = smart.balance_audience(ranked, data, need,
                                     topic_limit=0 if scheduled else smart.DAILY_TOPIC_LIMIT)
    queue.extend(selected)
    data["queue"] = queue
    meta["queue_size"] = len(queue)
    meta["last_scan_added"] = len(selected)
    meta["last_scan_funnel"] = funnel
    meta["wb_http"] = wb.health_snapshot()
    for pid in new_ids:
        old_seen.setdefault(pid, int(now))
    meta["discovery_seen"] = state._norm_discovery(old_seen)
    meta["scan_timezone"] = schedule["timezone"]
    zone = ZoneInfo(schedule["timezone"])
    day = datetime.fromtimestamp(now, zone).strftime("%Y-%m-%d")
    meta["new_day"] = day
    meta["new_today"] = sum(datetime.fromtimestamp(ts, zone).strftime("%Y-%m-%d") == day
                            for ts in meta["discovery_seen"].values())
    meta["last_scan_error"] = "" if seen else "WB не вернул товары; очередь сохранена"
    if seen:
        meta["last_scan_success"] = int(time.time())
    smart.tally_run(data, pool, queries, {})
    smart.tally_cats(data, cat_names, {})
    print("FOUND_FROM_SOURCE", len(seen), "ALREADY_KNOWN", funnel["already_known"],
          "NEW_PRODUCTS", len(new_ids), "VALID_AFTER_FILTER", len(eligible),
          "ADDED_TO_QUEUE", len(selected), "QUEUE_SIZE", len(queue), flush=True)
    print(f"Сканирование завершено: добавлено {len(selected)}, в очереди {len(queue)}/{target}")
    return len(selected)


def main():
    log.setup()
    settings = config.load_settings()
    if scheduler_client.enabled():
        scheduler_client.refresh(settings)
    config.apply(settings)
    data = state.load(config.STATE_FILE)
    data["queue"] = deal_queue.load(config.QUEUE_FILE)
    before_ids = {item["id"] for item in data["queue"]}
    if scheduler_client.enabled():
        with scheduler_client.lease("search", ttl=900) as owner:
            if not owner:
                print("SEARCH_SKIP: another scanner holds the lease", flush=True)
                return
            scheduler_client.refresh(settings)
            snapshot = scheduler_client.runtime("snapshot")
            scheduler_client.merge_runtime(data, snapshot)
            request_id = settings.get("schedule_search_request") or ""
            consumed = snapshot.get("consumed_requests") or []
            if any(row.get("kind") == "search" and row.get("request_id") == request_id for row in consumed if isinstance(row, dict)):
                request_id = ""
            if not request_id and not scheduling.search_due(settings, data, len(data["queue"])):
                print("SEARCH_SKIP: next scan not due", flush=True)
                return
            if request_id and not scheduler_client.runtime("consume", kind="search", owner=owner, request_id=request_id).get("ok"):
                print("SEARCH_SKIP: manual request already consumed", flush=True)
                return
            meta = data.setdefault("meta", {})
            meta["last_scan_attempt"] = int(time.time())
            # Failure metadata must not reuse results from the previous scan.
            meta["last_scan_funnel"] = {}
            meta["last_scan_added"] = 0
            meta["last_scan_error"] = ""
            try:
                deadline = time.monotonic() + 360
                with wb.request_budget(deadline=deadline):
                    fill_queue(data, settings, force_scan=True, deadline=deadline)
            except Exception as exc:
                meta["last_scan_error"] = "Ошибка поиска: " + type(exc).__name__
                state.record_error(data, meta["last_scan_error"])
                logger.error(meta["last_scan_error"])
            funnel = meta.get("last_scan_funnel") or {}
            _persist(data, before_ids)
            scheduler_client.runtime("scan_complete", owner=owner,
                                     found=funnel.get("found", 0), new=funnel.get("new", 0),
                                     added=meta.get("last_scan_added", 0), queue_size=len(data["queue"]),
                                     error=meta.get("last_scan_error", ""),
                                     timezone=scheduling.normalize(settings)["timezone"])
        return
    try:
        fill_queue(data, settings)
    except Exception as exc:
        state.record_error(data, f"Сканер упал: {exc}")
        logger.exception("Сканер упал")
    _persist(data, before_ids)


def _persist(data, before_ids):
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
