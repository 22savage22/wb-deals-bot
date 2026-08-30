import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import bot
import config
import scanner
import state
from test_bot import FakeWB, make_items


def main():
    crowded = [
        {"id": i, "query": "куртка мужская" if i < 8 else "платье женское"}
        for i in range(12)
    ]
    limited = scanner._limit_topics(crowded)
    assert len(limited) == 6
    assert sum(item["query"] == "куртка мужская" for item in limited) == 3
    print("0. crowded topics limited OK")

    old_bot_wb, old_scanner_wb = bot.wb, scanner.wb
    old_sleep, old_search = scanner.time.sleep, FakeWB.search
    try:
        bot.wb = FakeWB
        scanner.wb = FakeWB
        scanner.time.sleep = lambda _: None
        config.MIN_DISCOUNT = 20
        config.MIN_RATING = 0
        config.PAGES = 1
        config.QUERIES_PER_RUN = 4
        config.CATS_PER_RUN = 1
        config.QUEUE_MAX_AGE_HOURS = 8
        FakeWB.items = make_items(40, 8000)
        query_starts = {
            "платье женское": 8000, "джинсы женские": 8010,
            "футболка мужская": 8020, "товары для дома": 8030,
        }

        def varied_search(query, page, subject=None):
            start = query_starts.get(query)
            if subject is not None or start is None:
                return []
            return [FakeWB.items[pid] for pid in range(start, start + 10) if pid in FakeWB.items]

        FakeWB.search = staticmethod(varied_search)
        FakeWB.cat_menu = [("Электроника", "electronics"), ("18+ товары", "adult")]
        data = state._empty()
        queries = list(query_starts)
        added = scanner.fill_queue(data, {"queries": queries}, target=9)
        assert added == 9 and len(data["queue"]) == 9
        assert len({item["id"] for item in data["queue"]}) == 9
        assert all(item.get("quality") in ("A", "B", "C") for item in data["queue"])
        assert "18+ товары" not in data["cats"]
        assert data["meta"]["last_scan_added"] == 9
        print("1. scanner fills diverse queue OK")

        assert scanner.fill_queue(data, {"queries": queries}, target=9) == 0
        assert len(data["queue"]) == 9
        print("2. full queue skips WB scan OK")

        data["queue"][0]["queued_ts"] = int(time.time()) - 9 * 3600
        FakeWB.items = {}
        scanner.fill_queue(data, {"queries": queries}, target=9)
        assert len(data["queue"]) == 8
        print("3. expired queue entry pruned OK")
    finally:
        bot.wb = old_bot_wb
        scanner.wb = old_scanner_wb
        scanner.time.sleep = old_sleep
        FakeWB.search = staticmethod(old_search)


if __name__ == "__main__":
    main()
