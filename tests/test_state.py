import json
import os
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import state


def main():
    # 1. пустое состояние
    e = state._empty()
    assert set(e) == {
        "posted", "feedback", "query_stats", "cat_stats", "tg", "recent", "meta", "admin_ui", "titles",
        "img_hash", "learned", "prices", "cats", "queue",
    }
    print("1. empty OK")

    # 2. load отсутствующего файла
    assert state.load("C:/nope/state.json")["posted"] == {}
    print("2. load missing OK")

    # 3. нормализация posted: legacy список, инты, строки, старая запись режется
    now = int(time.time())
    raw = [
        {"id": "111", "ts": now - 100},
        "222",
        333,
        {"id": "444", "ts": now - 1000 * 86400},
        {"id": "bad", "ts": "x"},
    ]
    out = state._norm_posted(raw)
    assert out == {111: now - 100, 222: now, 333: now}, out
    print("3. norm posted OK")

    # 3b. dict-формат (как пишет save) — timestamps не теряются
    out = state._norm_posted({111: now - 500, 555: now - 1000 * 86400})
    assert out == {111: now - 500}, out
    print("3b. norm posted dict OK")

    # 4. нормализация feedback
    raw = {
        "5": {"likes": 2, "dislikes": 1, "bought": 0, "ts": now - 100, "query": "q"},
        "6": {"likes": 2, "dislikes": "x", "bought": 0, "ts": now - 1000 * 86400},
        "z": {"likes": 1},
    }
    out = state._norm_feedback(raw)
    assert 5 in out and out[5]["likes"] == 2
    assert 6 not in out and "z" not in out
    print("4. norm feedback OK")

    # 5. нормализация огрызков
    assert state._norm_recent("junk") == []
    assert state._norm_meta([1, 2]) == {}
    assert state._norm_admin_ui({"pending": 5}) == {"pending": None}
    assert state._norm_admin_ui([1]) == {"pending": None}
    assert state._norm_feedback("junk") == {}
    assert state._norm_stats("junk") == {}
    assert state._norm_tg([1]) == {"offset": 0}
    assert state._norm_meta([]) == {}
    print("5. norm junk OK")

    # 6. roundtrip save/load
    data = state._empty()
    data["posted"] = {1: now, 2: now}
    data["feedback"] = {"1": {"likes": 1, "dislikes": 0, "bought": 0, "ts": now, "query": None, "cat": None}}
    data["recent"] = [{"pid": 1, "title": "Т", "ts": now, "cat": "c", "query": "q", "link": "l", "discount": 50, "price": 100, "rating": 4.5}]
    data["meta"] = {"last_run": now, "total_posts": 3, "today_posts": 1, "today": time.strftime("%Y-%m-%d")}
    data["query_stats"] = {"q": {"posts": 1, "likes": 0, "dislikes": 0, "bought": 0, "ts": now}}
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
        path = f.name
    try:
        state.save(path, data)
        loaded = state.load(path)
        assert loaded["posted"] == data["posted"]
        assert loaded["meta"]["total_posts"] == 3
        assert loaded["recent"][0]["pid"] == 1
        assert loaded["admin_ui"] == {"pending": None}
        print("6. roundtrip OK")
    finally:
        os.unlink(path)

    # 7. merge: новее побеждает, пересечения recent
    base = state._empty()
    base["posted"] = {1: 100}
    base["feedback"] = {"1": {"likes": 1, "dislikes": 0, "bought": 0, "ts": 100, "query": None, "cat": None}}
    base["recent"] = [{"pid": 1, "title": "Old", "ts": 100}]
    base["meta"] = {"x": 1}
    local = state._empty()
    local["posted"] = {1: 200}
    local["feedback"] = {"1": {"likes": 2, "dislikes": 0, "bought": 0, "ts": 300, "query": None, "cat": None}}
    local["recent"] = [{"pid": 1, "title": "New", "ts": 200}, {"pid": 2, "title": "B", "ts": 50}]
    local["meta"] = {"y": 2}
    merged = state.merge(local, base)
    assert merged["posted"][1] == 200
    assert merged["feedback"]["1"]["likes"] == 2
    assert merged["recent"][0]["title"] == "New"
    assert merged["meta"]["x"] == 1 and merged["meta"]["y"] == 2
    print("7. merge OK")

    # 8. merge с None remote
    m = state.merge(local, None)
    assert m["posted"][1] == 200
    print("8. merge none OK")

    # 9. bump_meta
    d = state._empty()
    d["meta"]["today"] = "2000-01-01"
    state.bump_meta(d, 3)
    assert d["meta"]["total_posts"] == 3
    assert d["meta"]["today_posts"] == 3
    state.bump_meta(d, 2)
    assert d["meta"]["total_posts"] == 5 and d["meta"]["today_posts"] == 5
    print("9. bump_meta OK")

    # 10. нормализация json мусора
    assert state.load("C:/nope/файл.json")["tg"]["offset"] == 0
    print("10. junk load OK")

    # 11. img_hash: хранится 30 дней, мусор выкидывается
    out = state._norm_img_hash({"abc": now, 5: now, "old": now - 31 * 86400})
    assert out == {"abc": now}, out
    assert state._norm_img_hash("junk") == {}
    print("11. norm img_hash OK")

    # 12. learned: нормализация статусов
    raw = {
        "q1": {"ts": now, "attempts": 1, "posts": 0, "status": "trial"},
        "q2": {"ts": now, "attempts": 0, "posts": 3, "status": "weird"},
        "q3": {"ts": now, "attempts": 9, "posts": 0, "status": "retired"},
        "q4": {"ts": "x", "attempts": 1, "posts": 0, "status": "trial"},
        "q5": "junk",
    }
    out = state._norm_learned(raw)
    assert set(out) == {"q1", "q2", "q3"}, out
    assert out["q2"]["status"] == "active"  # posts>0 -> active, статус исправлен
    assert out["q3"]["status"] == "retired"
    assert state._norm_learned([]) == {}
    print("12. norm learned OK")

    # 13. merge объединяет img_hash и learned
    base = state._empty()
    base["img_hash"] = {"a": now - 2000, "b": now - 1000}
    base["learned"] = {"x": {"ts": now - 500, "attempts": 0, "posts": 0, "status": "trial"}}
    loc = state._empty()
    loc["img_hash"] = {"a": now - 100, "c": now - 50}
    loc["learned"] = {"x": {"ts": now, "attempts": 1, "posts": 0, "status": "trial"}, "y": {"ts": now, "attempts": 0, "posts": 1, "status": "active"}}
    merged = state.merge(loc, base)
    assert merged["img_hash"] == {"a": now - 100, "b": now - 1000, "c": now - 50}
    assert merged["learned"]["x"]["attempts"] == 1
    assert merged["learned"]["y"]["status"] == "active"
    print("13. merge new keys OK")

    # 14. save обрезает img_hash и списывает старые retired-запросы
    d = state._empty()
    d["img_hash"] = {"h1": now - 500, "h2": now - 31 * 86400}
    d["learned"] = {
        "a": {"ts": now, "attempts": 0, "posts": 2, "status": "active"},
        "b": {"ts": now - 1000, "attempts": 5, "posts": 0, "status": "retired"},
        "c": {"ts": now - 61 * 86400, "attempts": 5, "posts": 0, "status": "retired"},
    }
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
        path = f.name
    try:
        state.save(path, d)
        assert d["img_hash"] == {"h1": now - 500}, d["img_hash"]
        assert set(d["learned"]) == {"a", "b"}, d["learned"]
    finally:
        os.unlink(path)
    print("14. save prune OK")

    # 15. prices: нормализация, merge, обрезка в save
    out = state._norm_prices({1: {"price": 100, "basic": 200, "ts": now - 100},
                              "2": {"price": 0, "basic": 0, "ts": now},
                              "x": "junk",
                              3: {"price": 50, "basic": 100, "ts": now - 1000 * 86400}})
    assert 1 in out and out[1]["price"] == 100
    assert 2 not in out and "x" not in out and 3 not in out
    assert state._norm_prices([]) == {}
    base = state._empty()
    base["prices"] = {1: {"price": 200, "basic": 300, "ts": now - 500}}
    loc = state._empty()
    loc["prices"] = {1: {"price": 100, "basic": 200, "ts": now}, 2: {"price": 50, "basic": 100, "ts": now}}
    merged = state.merge(loc, base)
    assert merged["prices"][1]["price"] == 100  # свежее побеждает
    assert merged["prices"][2]["price"] == 50
    d = state._empty()
    d["prices"] = {1: {"price": 100, "basic": 200, "ts": now - 100},
                   2: {"price": 50, "basic": 100, "ts": now - 15 * 86400}}
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
        path = f.name
    try:
        state.save(path, d)
        assert set(d["prices"]) == {1}, d["prices"]
    finally:
        os.unlink(path)
    print("15. prices OK")

    # 16. record_error: журнал, обрезка до 20
    d = state._empty()
    for i in range(25):
        state.record_error(d, "ошибка %d" % i)
    errs = d["meta"]["errors"]
    assert len(errs) == 20 and errs[-1]["msg"] == "ошибка 24"
    assert errs[0]["msg"] == "ошибка 5"
    state.record_error(d, "x" * 500)
    assert len(d["meta"]["errors"][-1]["msg"]) == 400
    print("16. record_error OK")

    # 17. cats: нормализация, merge, обрезка в save
    out = state._norm_cats({1: "junk",
                            "Смартфоны": {"shard": "smartfony", "ts": now - 100, "runs": 3, "empty": 1},
                            "": {"shard": "x", "ts": now, "runs": 0, "empty": 0},
                            "Старые": {"shard": "old", "ts": now - 61 * 86400, "runs": 1, "empty": 5}})
    assert set(out) == {"Смартфоны", "Старые"}, out
    assert out["Смартфоны"]["shard"] == "smartfony" and out["Смартфоны"]["runs"] == 3
    assert state._norm_cats([]) == {}
    base = state._empty()
    base["cats"] = {"A": {"shard": "a", "ts": now - 500, "runs": 1, "empty": 0}}
    loc = state._empty()
    loc["cats"] = {"A": {"shard": "a", "ts": now, "runs": 2, "empty": 0}, "B": {"shard": "b", "ts": now, "runs": 0, "empty": 0}}
    merged = state.merge(loc, base)
    assert merged["cats"]["A"]["runs"] == 2 and merged["cats"]["B"]["shard"] == "b"
    d = state._empty()
    d["cats"] = {"A": {"shard": "a", "ts": now, "runs": 1, "empty": 0},
                 "B": {"shard": "b", "ts": now - 61 * 86400, "runs": 1, "empty": 0}}
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
        path = f.name
    try:
        state.save(path, d)
        assert set(d["cats"]) == {"A"}, d["cats"]
    finally:
        os.unlink(path)
    print("17. cats OK")

    # 18. queue: normalizes, deduplicates and merge removes published items
    d = state._empty()
    d["queue"] = [
        {"id": 50, "title": "A", "product": 100, "basic": 200,
         "discount": 50, "rating": 4.8, "feedbacks": 100,
         "category": "C", "queued_ts": now},
        {"id": 50, "title": "Old", "product": 120, "basic": 200,
         "discount": 40, "rating": 4.8, "feedbacks": 100,
         "category": "C", "queued_ts": now - 10},
    ]
    d = state._from_dict(d)
    assert len(d["queue"]) == 1 and d["queue"][0]["title"] == "A"
    remote = state._empty()
    remote["queue"] = list(d["queue"])
    local = state._empty()
    local["posted"] = {50: now}
    merged = state.merge(local, remote)
    assert merged["queue"] == []
    print("18. queue OK")

    # 19. stale scanner metadata must not roll back publisher counters/state
    remote = state._empty()
    remote["meta"] = {
        "today": "2026-08-16", "today_posts": 4, "total_posts": 14,
        "last_run": 400, "last_posts": 1, "last_funnel": {"published": 1},
        "last_scan": 100, "last_scan_added": 10, "queue_size": 27,
        "empty_notice_ts": 500, "errors": [{"ts": 100, "msg": "remote"}],
    }
    stale = state._empty()
    stale["meta"] = {
        "today": "2026-08-16", "today_posts": 2, "total_posts": 12,
        "last_run": 200, "last_posts": 0, "last_funnel": {"published": 0},
        "last_scan": 300, "last_scan_added": 3, "queue_size": 30,
        "empty_notice_ts": 300, "errors": [{"ts": 200, "msg": "local"}],
    }
    remote["recent"] = [
        {"pid": 9001, "title": "A", "ts": now},
        {"pid": 9002, "title": "B", "ts": now},
        {"pid": 9003, "title": "C", "ts": now},
        {"pid": 9004, "title": "D", "ts": now},
    ]
    remote["meta"]["today"] = state._moscow_day(now)
    stale["meta"]["today"] = state._moscow_day(now)
    remote["meta"]["today_posts"] = 2
    merged = state.merge(stale, remote)["meta"]
    assert merged["today_posts"] == 4 and merged["total_posts"] == 14
    assert merged["last_run"] == 400 and merged["last_posts"] == 1
    assert merged["last_funnel"] == {"published": 1}
    assert merged["last_scan"] == 300 and merged["last_scan_added"] == 3
    assert merged["queue_size"] == 30 and merged["empty_notice_ts"] == 500
    assert [e["msg"] for e in merged["errors"]] == ["remote", "local"]
    print("19. concurrent meta merge OK")


if __name__ == "__main__":
    main()
