import os
import random
import subprocess
import sys
import time

import admin
import config
import gitutil
import smart
import state
import tg
import wb


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


def run_posting(data, settings):
    posted = data["posted"]
    pool = settings.get("queries") or config.QUERIES or config.DEFAULT_QUERIES
    queries = smart.pick_queries(pool, data["query_stats"], min(4, len(pool)))

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

    if not seen:
        print("Поиск не дал результатов")
        return

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

    now = time.time()
    deals = [
        d
        for d in deals
        if not (d["id"] in posted and now - posted[d["id"]] < state.WEEK)
    ]
    deals.sort(
        key=lambda d: (
            d["discount"] + smart.cat_boost(d["category"], data["cat_stats"]),
            d["benefit"],
        ),
        reverse=True,
    )

    published = 0
    for deal in deals:
        if published >= config.MAX_POSTS:
            break
        pid = deal["id"]
        image = wb.photo(pid)
        if image is None:
            print("Нет фото:", pid)
            continue
        link = config.LINK_TEMPLATE.format(nm=pid)
        try:
            ok = tg.send_photo(
                config.TG_BOT_TOKEN,
                config.TG_CHAT_ID,
                image,
                tg.caption(deal),
                link,
                pid,
            )
        except Exception as exc:
            print("Ошибка публикации:", pid, exc)
            ok = False
        if ok:
            posted[pid] = int(now)
            published += 1
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
                }
            )
            smart.record_post(data, pid_query.get(pid), deal["category"])
            print("Опубликовано:", pid, f"{deal['discount']}%", deal["title"][:50])
        time.sleep(1.5)

    data["meta"]["last_run"] = int(now)
    data["meta"]["last_posts"] = published
    data["meta"]["last_queries"] = list(queries)
    print("Запросы этого запуска:", ", ".join(queries))


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
    if not config.TG_BOT_TOKEN or not config.TG_CHAT_ID:
        print("Задайте TG_BOT_TOKEN и TG_CHAT_ID")
        sys.exit(1)

    settings = config.load_settings()
    config.apply(settings)
    data = state.load(config.STATE_FILE)

    paused_until = settings.get("pause_until", 0) or 0
    if paused_until > time.time():
        print(
            "Постинг на паузе до",
            time.strftime("%Y-%m-%d %H:%M", time.localtime(paused_until)),
        )
    else:
        run_posting(data, settings)

    process_updates(data, settings)

    state.save(config.STATE_FILE, data)
    commit_state(config.STATE_FILE, data)

    print("Готово. Опубликовано:", data["meta"].get("last_posts", 0))


if __name__ == "__main__":
    if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    main()