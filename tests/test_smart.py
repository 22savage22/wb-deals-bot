import sys
import os
import time
import random

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import smart


def deal(pid, cat, disc, benefit=10, rating=4.5, feedbacks=10):
    return {
        "id": pid,
        "category": cat,
        "discount": disc,
        "benefit": benefit,
        "rating": rating,
        "feedbacks": feedbacks,
    }


def make_data(recent=None, cat_stats=None, feedback=None, meta=None):
    return {
        "posted": {},
        "feedback": feedback or {},
        "query_stats": {},
        "cat_stats": cat_stats or {},
        "tg": {},
        "recent": recent or [],
        "meta": meta or {},
        "admin_ui": {},
    }


def main():
    H = 3600
    base = [
        deal(1, "a", 60), deal(2, "a", 90), deal(3, "a", 40),
        deal(4, "b", 50), deal(5, "b", 30),
        deal(6, "c", 55), deal(7, "c", 20),
        deal(8, "d", 45),
    ]

    # 1. ротация категорий
    sel = smart.pick_deals(base, make_data(), 4)
    cats = [d["category"] for d in sel]
    assert sorted(cats) == ["a", "b", "c", "d"], cats
    print("1. rotation OK")

    # 2. второй круг при лимите > числа категорий
    sel = smart.pick_deals(base, make_data(), 6)
    cats = [d["category"] for d in sel]
    assert cats.count("a") == 2 and cats.count("b") == 2 and len(set(cats)) == 4, cats
    print("2. repeat round OK")

    # 3. свежезапощенная категория уходит в конец
    data = make_data(recent=[{"cat": "a", "ts": int(time.time())}])
    sel = smart.pick_deals(base, data, 3)
    cats = [d["category"] for d in sel]
    assert "a" not in cats, cats
    print("3. cooldown OK")

    # 4. cooldown истекает через 12 часов
    data = make_data(recent=[{"cat": "a", "ts": int(time.time()) - 13 * H}])
    sel = smart.pick_deals(base, data, 4)
    cats = [d["category"] for d in sel]
    assert "a" in cats, cats
    print("4. cooldown expiry OK")

    # 5. категория с перевесом дислайков исключается
    stats = {"a": {"posts": 5, "likes": 1, "dislikes": 4, "bought": 0, "ts": 0}}
    data = make_data(cat_stats=stats)
    sel = smart.pick_deals(base, data, 4)
    cats = [d["category"] for d in sel]
    assert "a" not in cats, cats
    print("5. rejected OK")

    # 6. граница исключения: дизлайков мало или лайки нивелируют
    stats = {"a": {"posts": 10, "likes": 3, "dislikes": 4, "bought": 0, "ts": 0}}
    assert smart._rejected(stats, "a") is False
    stats = {"a": {"posts": 10, "likes": 2, "dislikes": 5, "bought": 0, "ts": 0}}
    assert smart._rejected(stats, "a") is True
    print("6. rejection threshold OK")

    # 7. если всё отвергнуто — запасной вариант постит хоть что-то
    stats = {c: {"posts": 5, "likes": 0, "dislikes": 5, "bought": 0, "ts": 0} for c in "abcd"}
    sel = smart.pick_deals(base, make_data(cat_stats=stats), 2)
    assert len(sel) == 2
    print("7. fallback OK")

    # 8. пустой вход
    assert smart.pick_deals([], make_data(), 5) == []
    print("8. empty OK")

    # 9. pick_queries — топ и разведка
    pool = ["q1", "q2", "q3", "q4", "q5"]
    stats = {
        "q1": {"posts": 10, "likes": 9, "dislikes": 0, "bought": 0, "ts": 0},
        "q2": {"posts": 10, "likes": 1, "dislikes": 1, "bought": 0, "ts": 0},
    }
    for _ in range(30):
        picks = smart.pick_queries(pool, stats, 3)
        assert len(picks) == 3
        assert stats["q1"]["likes"] > stats["q2"]["likes"]
        assert "q1" in picks
    print("9. pick_queries OK")

    # 10. score и record
    s = smart.score({})
    assert s == 0.5
    data = make_data()
    smart.record_feedback(data, "q1", "Кат", "likes")
    data2 = make_data()
    smart.record_post(data2, "q1", "Кат")
    assert data["query_stats"]["q1"]["likes"] == 1
    assert data["cat_stats"]["Кат"]["likes"] == 1
    assert data2["query_stats"]["q1"]["posts"] == 1
    print("10. score/record OK")

    # 11. cat_boost
    good = {"posts": 10, "likes": 5, "dislikes": 1, "bought": 0, "ts": 0}
    bad = {"posts": 10, "likes": 1, "dislikes": 6, "bought": 0, "ts": 0}
    assert smart.cat_boost("c", {"c": good}) == 2.0
    assert smart.cat_boost("c", {"c": bad}) == -1.5
    print("11. cat_boost OK")

    # 12. notice_ok — троттлинг
    data = make_data()
    assert smart.notice_ok(data, "k", 1000) is True
    assert smart.notice_ok(data, "k", 1000) is False
    data["meta"]["k"] = int(time.time()) - 2000
    assert smart.notice_ok(data, "k", 1000) is True
    print("12. notice_ok OK")

    # 13. дайджест админа
    now = int(time.time())
    data = make_data(
        recent=[
            {"pid": 1, "title": "Товар один", "discount": 70, "ts": now - 10, "link": "https://x/1", "cat": "c", "query": "q", "price": 100, "rating": 4},
            {"pid": 2, "title": "Товар два", "discount": 40, "ts": now - 30 * H, "link": "https://x/2", "cat": "c", "query": "q", "price": 100, "rating": 4},
        ],
        feedback={"1": {"likes": 5, "dislikes": 1, "bought": 2, "ts": now - 5, "query": "q", "cat": "c"}},
        meta={"total_posts": 10, "last_queries": ["q1"]},
    )
    d = smart.admin_digest(data)
    assert "Отчёт за сутки" in d
    assert "Постов: <b>1</b>" in d
    assert "👍 5" in d
    assert "Товар один" in d
    assert "q1" in d
    print("13. admin_digest OK")

    # 14. недельный дайджест
    d = smart.week_digest(data)
    assert "Итоги недели" in d
    assert "2</b> находок" in d
    assert "Топ-3" in d
    assert "#итоги" in d
    assert "Спасибо" in d
    print("14. week_digest OK")

    # 15. пустые дайджесты не падают
    assert smart.admin_digest(make_data())
    assert smart.week_digest(make_data())
    print("15. empty digests OK")

    # 16. summary работает
    assert "наушники" in smart.summary({"наушники": good}, {}, 5)
    print("16. summary OK")

    # 17. активные выученные запросы входят в пул
    data = make_data()
    data["learned"] = {
        "новинка": {"ts": 0, "attempts": 0, "posts": 3, "status": "active"},
        "пустышка": {"ts": 0, "attempts": 5, "posts": 0, "status": "retired"},
    }
    for _ in range(20):
        picks = smart.pick_queries(["база"], {}, 2, data)
        assert len(picks) == 2, picks
        assert "новинка" in picks
        assert "пустышка" not in picks
    print("17. learned in pool OK")

    # 18. tally_run: пост -> active, пустота -> попытка, 5 попыток -> retired
    data = make_data()
    smart.tally_run(data, ["база"], ["куртка мужская"], {"куртка мужская": 2})
    assert data["learned"]["куртка мужская"]["status"] == "active"
    assert data["learned"]["куртка мужская"]["posts"] == 2
    smart.tally_run(data, ["база"], ["куртка мужская"], {})
    assert data["learned"]["куртка мужская"]["status"] == "active"  # посты не теряются
    smart.tally_run(data, ["база"], ["джинсы мужские"], {})
    assert data["learned"]["джинсы мужские"]["attempts"] == 1
    for _ in range(4):
        smart.tally_run(data, ["база"], ["джинсы мужские"], {})
    assert data["learned"]["джинсы мужские"]["status"] == "retired"
    # админские запросы не трогаем
    smart.tally_run(data, ["база"], ["база"], {})
    assert "база" not in data["learned"]
    print("18. tally_run OK")

    # 19. learn_categories: успешная категория становится запросом раз в сутки
    data = make_data()
    data["cat_stats"] = {
        "Наушники беспроводные": {"posts": 5, "likes": 4, "dislikes": 0, "bought": 0, "ts": 0},
        "Носки": {"posts": 5, "likes": 0, "dislikes": 0, "bought": 0, "ts": 0},
        "другое": {"posts": 9, "likes": 9, "dislikes": 0, "bought": 0, "ts": 0},
    }
    added = smart.learn_categories(data, ["база"])
    assert added == 1, added
    assert "Наушники беспроводные" in data["learned"]
    assert data["learned"]["Наушники беспроводные"]["status"] == "active"
    assert "другое" not in data["learned"]
    added2 = smart.learn_categories(data, ["база"])
    assert added2 == 0  # раз в сутки
    print("19. learn_categories OK")

    # 20. learned_counts
    data = make_data()
    data["learned"] = {
        "a": {"ts": 0, "attempts": 0, "posts": 1, "status": "active"},
        "b": {"ts": 0, "attempts": 1, "posts": 0, "status": "trial"},
        "c": {"ts": 0, "attempts": 5, "posts": 0, "status": "retired"},
    }
    assert smart.learned_counts(data) == (1, 1)
    print("20. learned_counts OK")

    # 21. price_drop: падение на 15%+ -> репост, рост -> базовая линия обновляется
    prices = {1: {"price": 1000, "basic": 2000, "ts": 0}}
    d = deal(1, "a", 50)
    d["product"] = 900
    assert smart.price_drop(d, prices, 0.15) is False  # -10% мало
    d["product"] = 850
    assert smart.price_drop(d, prices, 0.15) is True
    assert d.get("price_drop") is True and d.get("last_price") == 1000
    assert prices[1]["price"] == 1000  # базовая линия не сдвинулась вниз
    d["product"] = 1200
    assert smart.price_drop(d, prices, 0.15) is False  # рост
    assert prices[1]["price"] == 1200  # линия поднялась
    assert smart.price_drop(d, prices, 0.15) is False
    assert smart.price_drop(d, {}, 0.15) is False  # нет истории
    d2 = deal(9, "a", 50)
    d2["product"] = 1
    assert smart.price_drop(d2, prices, 0.15) is False
    print("21. price_drop OK")

    # 22. refresh_categories: категории из каталога, статистика не теряется
    data = make_data()
    added = smart.refresh_categories(data, [("Смартфоны", "smartfony"), ("Кроссовки", "krossovki")])
    assert added == 2
    assert data["cats"]["Смартфоны"]["shard"] == "smartfony"
    data["cats"]["Смартфоны"]["runs"] = 5
    assert smart.refresh_categories(data, [("Смартфоны", "smartfony")]) == 0  # повторно не добавляет
    assert data["cats"]["Смартфоны"]["runs"] == 5  # статистика на месте
    assert smart.refresh_categories(data, []) == 0
    print("22. refresh_categories OK")

    # 23. pick_categories: ротация + вес успешных, пустые на пенсию
    data = make_data()
    smart.refresh_categories(data, [("A", "a"), ("B", "b"), ("C", "c")])
    data["cat_stats"]["A"] = {"posts": 10, "likes": 9, "dislikes": 0, "bought": 0, "ts": 0}
    random.seed(1)
    seen = set()
    for _ in range(60):
        picks = smart.pick_categories(data, 1)
        assert len(picks) == 1
        seen.add(picks[0])
    assert "A" in seen  # успешная категория рано или поздно попадает
    assert smart.pick_categories(make_data(), 2) == []  # пусто — нет категорий
    data2 = make_data()
    smart.refresh_categories(data2, [("A", "a"), ("B", "b")])
    for _ in range(5):
        smart.tally_cats(data2, ["A"], {})
    picks = smart.pick_categories(data2, 2)
    assert "A" not in picks  # 5 пустых запусков — категория на пенсии
    data2["cats"]["A"]["ts"] = int(time.time()) - 15 * 86400
    picks = smart.pick_categories(data2, 2)
    assert "A" in picks  # через 14 дней возвращается
    assert data2["cats"]["A"]["empty"] == 0
    print("23. pick_categories OK")

    # 24. tally_cats: пост сбрасывает пустоту, пустота копится
    data = make_data()
    smart.refresh_categories(data, [("A", "a")])
    smart.tally_cats(data, ["A"], {"A": 2})
    assert data["cats"]["A"]["runs"] == 1 and data["cats"]["A"]["empty"] == 0
    smart.tally_cats(data, ["A"], {})
    assert data["cats"]["A"]["empty"] == 1 and data["cats"]["A"]["runs"] == 2
    smart.tally_cats(data, [], {})
    assert data["cats"]["A"]["runs"] == 2  # пустой список не трогает
    print("24. tally_cats OK")

    # 25. качественный рейтинг учитывает доверие, отзывы и реальную выгоду
    weak = deal(1, "a", 70, benefit=100, rating=3.5, feedbacks=0)
    trusted = deal(2, "a", 60, benefit=5000, rating=4.9, feedbacks=900)
    assert smart.deal_score(trusted) > smart.deal_score(weak)
    fallback = dict(trusted, selection_mode="smart_fallback")
    assert smart.deal_score(fallback) < smart.deal_score(trusted)
    print("25. deal_score OK")


if __name__ == "__main__":
    main()
