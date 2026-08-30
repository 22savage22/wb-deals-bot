import json
import os
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import deal_queue


def item(pid, ts):
    return {
        "id": pid, "title": f"Товар {pid}", "product": 100, "basic": 200,
        "discount": 50, "rating": 4.8, "feedbacks": 100,
        "category": "Дом", "queued_ts": ts,
    }


def main():
    now = int(time.time())
    merged = deal_queue.merge([item(1, now)], [item(2, now), item(1, now - 1)])
    assert {x["id"] for x in merged} == {1, 2}
    assert [x["id"] for x in deal_queue.merge(merged, [], {1: now})] == [2]
    assert [x["id"] for x in deal_queue.merge([item(1, now)], merged, removed={2})] == [1]
    print("1. queue merge + published filter OK")

    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
        path = f.name
        json.dump([item(3, now)], f)
    try:
        saved = deal_queue.save(path, [item(4, now)])
        assert saved[0]["id"] == 4
        with open(path, encoding="utf-8") as f:
            assert json.load(f)[0]["id"] == 4
    finally:
        os.unlink(path)
    print("2. queue file roundtrip OK")


if __name__ == "__main__":
    main()
