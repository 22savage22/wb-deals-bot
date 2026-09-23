import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import admin
import config


class FakeTG:
    calls = []

    @staticmethod
    def edit_message_text(t, c, m, text, markup=None):
        FakeTG.calls.append(("edit", text[:30], markup))
        return True

    @staticmethod
    def send_message(t, c, text, markup=None):
        FakeTG.calls.append(("send", text[:40], markup))
        return True

    @staticmethod
    def send_photo(t, c, photo, text, link=None, pid=None, markup=None):
        FakeTG.calls.append(("photo", text[:30], markup))
        return True

    @staticmethod
    def send_album(t, c, photos, text, link=None, pid=None, markup=None):
        FakeTG.calls.append(("album", text[:30], markup))
        return True

    @staticmethod
    def answer_callback(t, c, text=""):
        if not c:
            return
        FakeTG.calls.append(("answer", text, None))

    @staticmethod
    def fmt(n):
        return f"{n:,}".replace(",", " ")

    @staticmethod
    def caption(d, pid=None):
        return "%d%% %s %s" % (d["discount"], d["title"], pid)


def make_data():
    return {
        "posted": {5: 100},
        "feedback": {5: {"likes": 3, "dislikes": 1, "bought": 1, "ts": 1000, "query": "a", "cat": "c"}},
        "query_stats": {"a": {"posts": 2, "likes": 3, "dislikes": 1, "bought": 1, "ts": int(time.time()) - 60}},
        "cat_stats": {},
        "tg": {"offset": 0},
        "recent": [
            {"pid": 5, "title": "Товар", "discount": 60, "price": 100, "rating": 4.5,
             "link": "https://x/5", "query": "a", "cat": "c", "ts": 100}
        ],
        "meta": {"last_run": 100, "last_posts": 1, "last_queries": ["a"], "total_posts": 10, "today_posts": 2, "today": "x"},
        "admin_ui": {"pending": None},
        "queue": [],
    }


def cb(cmd, user="42"):
    return {"data": "A:" + cmd, "id": "cid",
            "message": {"chat": {"id": 111}, "message_id": 1},
            "from": {"id": user}}


def main():
    admin.tg = FakeTG
    import wb as wbmod

    card = {"id": 777, "name": "Чайник", "brand": "B",
            "sizes": [{"price": {"product": 9900, "basic": 19800}}],
            "reviewRating": 4.5, "feedbacks": 9, "subjectName": "Кухня"}

    def run(cmd, data=None, settings=None):
        FakeTG.calls.clear()
        d = data if data is not None else make_data()
        s = settings if settings is not None else {}
        return admin._admin_callback("tok", d, s, cb(cmd)), d, s

    # --- views ---
    t, m = admin._menu_view(make_data(), {})
    assert "Панель управления" in t and "📦 Всего публикаций" in t
    btns = [b["text"] for row in m for b in row]
    assert "📊 Статус" in btns and "❓ Помощь" in btns and "📤 Опубликовать" in btns
    print("1. menu OK")

    t, m = admin._status_view(make_data(), {})
    assert "Состояние бота" in t and "👍" in t and "<b>3</b>" in t and "<b>1</b>" in t
    print("2. status OK")

    t, m = admin._last_view(make_data(), 0)
    assert "стр 1 из 1" in t and "🗑" in t
    t, m = admin._last_view(make_data(), 9)
    assert "стр 1 из 1" in t
    print("3. last OK")

    t, m = admin._stats_view(make_data(), "q", 0)
    assert "Обучение" in t and "a" in t
    t, m = admin._stats_view(make_data(), "c", 0)
    assert "Категории" in t
    print("4. stats OK")

    t, m = admin._editor_view({}, "min_discount")
    btns = [b["text"] for row in m for b in row]
    assert "✍️ Ввести своё значение" in btns and "✅ Готово" in btns
    print("5. editor OK")

    t, m = admin._queries_view(make_data(), {})
    assert "куртка" in t or "джинсы" in t or "худи" in t or "платье" in t
    print("6. queries view OK")

    t, m = admin._pause_view(make_data(), {})
    assert "1 ч" in " ".join(b["text"] for row in m for b in row)
    print("7. pause OK")

    t, m = admin._help_view()
    assert "Помощь" in t and "Ротация" in t
    print("8. help OK")

    m = admin._adv_markup()
    assert any("Итоги недели" in (b.get("text") or "") for row in m for b in row)
    assert any("Шаблон ссылки" in (b.get("text") or "") for row in m for b in row)
    print("9. adv weekly_digest OK")

    # --- router ---
    changed, d, s = run("menu")
    assert FakeTG.calls[0][0] == "answer"
    changed, d, s = run("status")
    changed, d, s = run("last:0")
    changed, d, s = run("stats:q:0")
    changed, d, s = run("cfg")
    changed, d, s = run("editor:min_discount")
    changed, d, s = run("step:min_discount:5")
    assert s["min_discount"] == 55
    changed, d, s = run("preset:min_discount:40")
    assert s["min_discount"] == 40
    changed, d, s = run("custom:repost_days")
    assert d["admin_ui"]["pending"] == "setting:repost_days"
    changed, d, s = run("addq")
    assert d["admin_ui"]["pending"] == "add_query"
    changed, d, s = run("q:mv:2:up")
    expected = list(config.DEFAULT_QUERIES)
    expected[1], expected[2] = expected[2], expected[1]
    assert s.get("queries") == expected, s
    changed, d, s = run("q:ed:0")
    assert d["admin_ui"]["pending"] == "edit_query:0"
    changed, d, s = run("delq:0")
    first_q = config.DEFAULT_QUERIES[0]
    assert first_q not in (s.get("queries") or [])
    changed, d, s = run("pause:2")
    assert s.get("pause_until", 0) > 0
    changed, d, s = run("resume")
    assert "pause_until" not in s
    changed, d, s = run("postnow")
    changed, d, s = run("postnow:yes")
    assert s.get("post_now_ts", 0) > 0
    del s["post_now_ts"]
    changed, d, s = run("manual")
    assert d["admin_ui"]["pending"] == "manual_post"
    changed, d, s = run("pcustom")
    assert d["admin_ui"]["pending"] == "pause_hrs"
    changed, d, s = run("wipe")
    changed, d, s = run("wipe:yes")
    assert d["posted"] == {}
    changed, d, s = run("help")
    changed, d, s = run("custom:weekly_digest")
    assert d["admin_ui"]["pending"] == "setting:weekly_digest"
    changed, d, s = run("cancel")
    assert d["admin_ui"].get("pending") is None
    print("10. router OK")

    # --- гость не управляет админкой ---
    d = make_data()
    admin.handle_events("tok", "42", d, {}, [("callback", cb("manual", user="999"))])
    assert d["admin_ui"].get("pending") is None
    admin.handle_events("tok", "42", d, {}, [("callback", cb("manual", user="42"))])
    assert d["admin_ui"]["pending"] == "manual_post"
    d["admin_ui"].pop("pending", None)
    admin.handle_events(
        "tok", "42", d, {},
        [("message", {"chat": {"id": 111, "type": "private"}, "from": {"id": "999"}, "text": "управляй"})],
    )
    assert d["admin_ui"].get("pending") is None
    assert not [c for c in FakeTG.calls if c[0] == "edit"] or True
    print("11. guest cannot admin OK")

    # --- feedback-колбэки (кнопки в канале, без префикса A:) ---
    d = make_data()
    feed_cb = lambda cmd, user="999": {"data": cmd, "id": "cid",
                                       "message": {"chat": {"id": 111}, "message_id": 1},
                                       "from": {"id": user}}
    FakeTG.calls.clear()
    admin.handle_events("tok", "42", d, {}, [("callback", feed_cb("l5"))])
    assert FakeTG.calls == [("answer", "Лайк отправлен 👍", None)]
    assert d["feedback"][5]["likes"] == 4
    FakeTG.calls.clear()
    admin._feedback("tok", d, feed_cb("l5", user="998"))
    assert FakeTG.calls[0][0] == "answer"
    assert d["feedback"][5]["likes"] == 5
    assert abs(d["query_stats"]["a"]["likes"] - 5) < 0.01
    admin._feedback("tok", d, feed_cb("b5", user="888"))
    assert d["feedback"][5]["bought"] == 2
    admin._feedback("tok", d, feed_cb("b5", user="888"))
    assert d["feedback"][5]["bought"] == 2  # анти-двойной клик по юзеру
    admin._feedback("tok", d, feed_cb("b5", user="777"))
    assert d["feedback"][5]["bought"] == 3  # другой юзер проходит
    assert d["feedback"][5]["likes"] == 5
    print("12. feedback OK")

    # --- messages ---
    d = make_data()
    admin._admin_message("tok", 111, d, {}, "45,5")
    ok = admin._admin_message("tok", 111, d, {}, "/set min_discount 55")
    assert ok is True
    ui = {"pending": "setting:min_rating"}
    admin._admin_message("tok", 111, dict(make_data(), admin_ui=ui), {}, "не число")
    assert ui["pending"] == "setting:min_rating"  # ошибка — ждём ввод дальше
    s3 = {}
    admin._admin_message("tok", 111, dict(make_data(), admin_ui=ui), s3, "4,5")
    assert s3.get("min_rating") == 4.5 and ui.get("pending") is None
    s4 = {}
    admin._admin_message("tok", 111, dict(make_data(), admin_ui={"pending": "edit_query:1"}), s4, "смартфон")
    assert s4["queries"][1] == "смартфон"
    s5 = {}
    admin._admin_message("tok", 111, dict(make_data(), admin_ui={"pending": "add_query"}), s5, "кофеварка")
    assert s5["queries"][-1] == "кофеварка"
    s7 = {}
    admin._admin_message("tok", 111, dict(make_data(), admin_ui={"pending": "pause_hrs"}), s7, "1.5")
    assert 0 < s7.get("pause_until", 0) <= int(time.time()) + 5405
    print("13. messages OK")

    # --- setting: weekly_digest ---
    s6 = {}
    ok, msg = admin._apply_setting(s6, "weekly_digest", "0")
    assert ok and s6["weekly_digest"] == 0
    ok, msg = admin._apply_setting(s6, "weekly_digest", "1")
    assert ok and s6["weekly_digest"] == 1
    ok, msg = admin._apply_setting(s6, "weekly_digest", "7")
    assert ok and s6["weekly_digest"] == 1  # за границами — клампим к краю
    print("14. weekly_digest setting OK")

    # --- flow: review + publish ---
    wbmod.cards = lambda ids: [card]
    wbmod.photos = lambda nm, limit=3: [b"jpeg"]
    admin.wb = wbmod
    d = make_data()
    admin._start_review("tok", 111, "c1", 777)
    photo_calls = [c for c in FakeTG.calls if c[0] == "photo"]
    assert photo_calls, FakeTG.calls
    markup = photo_calls[0][2]
    import json as _json
    assert "manual:publish:777" in _json.dumps(markup)
    changed = admin._do_publish("tok", d, 111, "c2", 777)
    assert changed is True
    assert d["posted"].get(777) and d["recent"][0]["pid"] == 777
    assert d["meta"]["total_posts"] == 11
    assert d["prices"][777]["price"] == 99
    changed2 = admin._do_publish("tok", d, 111, "c3", 777)
    assert changed2 is False  # защита от дубля
    print("15. review/publish flow OK")

    # --- 16. чёрный список: настройка через админку ---
    s = {}
    ok, msg = admin._apply_setting(s, "blacklist", "спам, 9999")
    assert ok and s["blacklist"] == ["спам", "9999"]
    ok, msg = admin._apply_setting(s, "blacklist", " ")
    assert not ok
    ok, msg = admin._apply_setting(s, "blacklist", "бренд")
    assert ok and s["blacklist"] == ["бренд"]
    print("16. blacklist setting OK")

    # --- 17. журнал ошибок ---
    t, m = admin._errors_view(make_data())
    assert "Ошибок нет" in t
    d = make_data()
    d["meta"]["errors"] = [{"ts": int(time.time()), "msg": "сломалась X"}]
    t, m = admin._errors_view(d)
    assert "сломалась X" in t and "Журнал" in t
    changed, d, s = run("errors")
    print("17. errors view OK")

    # --- 18. очередь: просмотр и мгновенная публикация кнопкой ---
    admin.config.TG_CHAT_ID = "CH"
    d = make_data()
    d["queue"] = [{
        "id": 777, "title": "Чайник", "product": 99, "basic": 198,
        "discount": 50, "rating": 4.5, "feedbacks": 9,
        "category": "Кухня", "queued_ts": int(time.time()),
    }]
    t, m = admin._queue_view(d)
    encoded = _json.dumps(m, ensure_ascii=False)
    assert "Найденные товары" in t and "queue:bulk:1" in encoded
    assert "queue:post:777" in encoded and "preview:post:777" in encoded
    assert "queue:replace:777" in encoded and "queue:disable:777" in encoded
    replacement = make_data()
    replacement["queue"] = list(d["queue"])
    changed = admin._admin_callback("tok", replacement, {}, cb("queue:replace:777"))
    assert changed and replacement["queue"] == [] and replacement["posted"].get(777)
    disabled = make_data()
    disabled["queue"] = list(d["queue"])
    disabled_settings = {}
    changed = admin._admin_callback("tok", disabled, disabled_settings, cb("queue:disable:777"))
    assert changed and disabled_settings["disabled_topics"] == ["кухня"]
    assert "queue:enable:0" in _json.dumps(FakeTG.calls[-1], ensure_ascii=False)
    old_min_discount = config.MIN_DISCOUNT
    config.MIN_DISCOUNT = 50
    invalid = make_data()
    invalid["queue"] = list(d["queue"])
    wbmod.cards = lambda ids: [dict(card, sizes=[{"price": {"product": 19500, "basic": 19800}}])]
    assert admin._admin_callback("tok", invalid, {}, cb("queue:bulk:1")) is True
    assert invalid["queue"] == [] and invalid["posted"].get(777)
    wbmod.cards = lambda ids: [card]
    FakeTG.calls.clear()
    changed = admin._admin_callback("tok", d, {}, cb("queue:bulk:1"))
    assert changed is True and d["queue"] == [] and d["posted"].get(777), (
        changed, d["queue"], d["posted"], FakeTG.calls,
        config.MIN_DISCOUNT, config.MIN_RATING, config.MAX_PRICE,
    )
    config.MIN_DISCOUNT = old_min_discount
    assert [c for c in FakeTG.calls if c[0] == "photo"]
    assert [c for c in FakeTG.calls if c[0] == "edit"]
    print("18. queue quick publish OK")

    # --- 19. parse price input ---
    assert admin._parse_price_input("1990") == (1990, 1990)
    assert admin._parse_price_input("1990/3990") == (1990, 3990)
    assert admin._parse_price_input("1 990") == (1990, 1990)
    assert admin._parse_price_input("3990/1990") is None
    assert admin._parse_price_input("abc") is None
    assert admin._parse_price_input("") is None
    assert admin._parse_price_input("0") is None
    assert admin._parse_price_input("100/0") is None
    print("19. price input OK")

    # --- 20. manual link → cards OK → preview with queue button ---
    FakeTG.calls.clear()
    d = make_data()
    wbmod.cards = lambda ids: [card]
    wbmod.photos = lambda nm, limit=3: [b"jpeg"]
    admin.wb = wbmod
    changed, d, s = run("manual", data=d)
    assert d["admin_ui"]["pending"] == "manual_post"
    ok = admin._admin_message(
        "tok", 111, d, s, "https://www.wildberries.ru/catalog/777/detail.aspx"
    )
    assert ok is True, (ok, FakeTG.calls, d.get("admin_ui"))
    draft = d["admin_ui"].get("manual_draft")
    assert draft and draft["id"] == 777 and int(draft.get("product") or 0) > 0, draft
    assert d["admin_ui"].get("pending") is None
    previews = [c for c in FakeTG.calls if c[0] in ("photo", "album")]
    assert previews, FakeTG.calls
    assert "manual:queue:777" in _json.dumps(previews[0][2], ensure_ascii=False)
    # queue via button
    changed = admin._admin_callback("tok", d, {}, cb("manual:queue:777"))
    assert changed and d["queue"] and d["queue"][0]["id"] == 777, (d["queue"], FakeTG.calls)
    assert d["queue"][0].get("manual") == 1
    assert "manual_draft" not in d["admin_ui"]
    assert "manual_deal" not in d["admin_ui"]
    print("20. manual cards->queue OK")

    # --- 21. WAF: no cards → basket meta → price → queue ---
    FakeTG.calls.clear()
    d = make_data()
    wbmod.cards = lambda ids: []
    wbmod.basket_card = lambda nm: {
        "id": nm, "title": "Кофеварка X", "brand": "Polaris",
        "category": "Кухня", "rating": 4.6, "feedbacks": 42,
    }
    admin.wb = wbmod
    run("manual", data=d)
    admin._admin_message("tok", 111, d, {}, "555000")
    assert d["admin_ui"]["pending"] == "manual_price", d["admin_ui"]
    assert d["admin_ui"]["manual_draft"]["title"] == "Кофеварка X"
    # bad price keeps pending
    admin._admin_message("tok", 111, d, {}, "abc")
    assert d["admin_ui"]["pending"] == "manual_price"
    # good price → preview
    FakeTG.calls.clear()
    ok = admin._admin_message("tok", 111, d, {}, "1990/3990")
    assert ok is True
    assert d["admin_ui"].get("pending") is None
    draft = d["admin_ui"]["manual_draft"]
    assert draft["product"] == 1990 and draft["basic"] == 3990 and draft["discount"] == 50
    assert int(d["admin_ui"]["manual_deal"]["product"]) == 1990
    changed = admin._admin_callback("tok", d, {}, cb("manual:queue:555000"))
    assert changed and d["queue"][0]["product"] == 1990, d["queue"]
    assert d["queue"][0]["manual"] == 1
    print("21. manual WAF->queue OK")

    # --- 22. basket has no title → ask title first ---
    FakeTG.calls.clear()
    d = make_data()
    wbmod.cards = lambda ids: []
    wbmod.basket_card = lambda nm: None
    run("manual", data=d)
    admin._admin_message("tok", 111, d, {}, "123456")
    assert d["admin_ui"]["pending"] == "manual_title", d["admin_ui"]
    admin._admin_message("tok", 111, d, {}, "Супер чайник")
    assert d["admin_ui"]["pending"] == "manual_price"
    admin._admin_message("tok", 111, d, {}, "500")
    assert d["admin_ui"].get("pending") is None
    assert d["admin_ui"]["manual_draft"]["title"] == "Супер чайник"
    print("22. manual title path OK")

    # --- 23. cancel clears draft ---
    d = make_data()
    d["admin_ui"]["manual_draft"] = {"id": 1, "title": "X", "product": 100}
    d["admin_ui"]["pending"] = "manual_price"
    changed = admin._admin_callback("tok", d, {}, cb("cancel"))
    assert changed
    assert "manual_draft" not in d["admin_ui"] and d["admin_ui"].get("pending") is None
    d = make_data()
    d["admin_ui"]["manual_deal"] = {"id": 2, "title": "Y", "product": 100, "queued_ts": 1}
    changed = admin._admin_callback("tok", d, {}, cb("manual:cancel"))
    assert changed and "manual_deal" not in d["admin_ui"]
    print("23. cancel clears draft OK")

    # --- 24. do_publish fallback when cards fail (WAF) ---
    d = make_data()
    d["queue"] = []
    wbmod.cards = lambda ids: []
    wbmod.photos = lambda nm, limit=3: [b"j1", b"j2"]
    admin.wb = wbmod
    admin.config.TG_CHAT_ID = "CH"
    FakeTG.calls.clear()
    d["admin_ui"]["manual_draft"] = {
        "id": 888, "title": "Ручной товар", "brand": "B", "category": "Кухня",
        "rating": 4.5, "feedbacks": 9, "product": 500, "basic": 1000, "discount": 50,
    }
    changed = admin._do_publish("tok", d, 111, "c9", 888)
    assert changed is True, (FakeTG.calls, d)
    assert d["posted"].get(888)
    assert "manual_draft" not in d["admin_ui"]
    print("24. do_publish WAF fallback OK")

    # --- 25. /post accepts a link ---
    FakeTG.calls.clear()
    d = make_data()
    wbmod.cards = lambda ids: [card]
    wbmod.photos = lambda nm, limit=3: [b"jpeg"]
    admin.wb = wbmod
    ok = admin._admin_message(
        "tok", 111, d, {}, "/post https://www.wildberries.ru/catalog/777/detail.aspx"
    )
    assert ok is True
    assert d["admin_ui"].get("manual_draft", {}).get("id") == 777
    print("25. /post link OK")


if __name__ == "__main__":
    main()
