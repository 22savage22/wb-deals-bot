import os
import random
import subprocess
import sys
import time

import config
import state
import tg
import wb


def _run(*args):
    res = subprocess.run(args, capture_output=True, text=True)
    if res.returncode != 0:
        print("git error:", " ".join(args), "->", res.returncode)
        print(res.stderr.strip()[:400])
    return res


def commit_state(path):
    if not os.getenv("GITHUB_TOKEN"):
        print("GITHUB_TOKEN не задан, state не коммитится")
        return
    status = _run("git", "status", "--porcelain", path)
    if not status.stdout.strip():
        print("state.json не изменился, коммит не нужен")
        return
    _run("git", "config", "user.name", "wb-bot")
    _run("git", "config", "user.email", "actions@github.com")
    _run("git", "add", path)
    _run("git", "commit", "-m", "chore: update state")
    _run("git", "push")
    print("state.json закоммичен")


def main():
    if not config.TG_BOT_TOKEN or not config.TG_CHAT_ID:
        print("Задайте TG_BOT_TOKEN и TG_CHAT_ID")
        sys.exit(1)

    posted = state.load(config.STATE_FILE)
    queries = config.QUERIES or config.DEFAULT_QUERIES

    seen = {}
    for query in queries:
        for page in range(1, config.PAGES + 1):
            items = wb.search(query, page)
            if not items:
                break
            for item in items:
                pid = item.get("id")
                if pid:
                    seen.setdefault(pid, item)
            time.sleep(random.uniform(2.0, 4.0))
        time.sleep(random.uniform(3.0, 6.0))

    if not seen:
        print("Поиск не дал результатов")
        commit_state(config.STATE_FILE)
        return

    ids = list(seen.keys())
    cards = wb.cards(ids)

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

    deals.sort(key=lambda d: (d["discount"], d["benefit"]), reverse=True)

    published = 0
    for deal in deals:
        if published >= config.MAX_POSTS:
            break
        pid = deal["id"]
        if pid in posted:
            continue
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
            )
        except Exception as exc:
            print("Ошибка публикации:", pid, exc)
            ok = False
        if ok:
            posted.add(pid)
            published += 1
            print("Опубликовано:", pid, f"{deal['discount']}%", deal["title"][:50])
        time.sleep(1.5)

    state.save(config.STATE_FILE, posted)
    commit_state(config.STATE_FILE)
    print("Готово. Опубликовано:", published)


if __name__ == "__main__":
    if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    main()
