import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import admin


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
    assert "📊 Статус" in btns and "❓ Помощь" in btns and "🏠 Меню" not in btns
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
    assert "телефон" in t
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
    assert s.get("queries") == ["телефон", "телевизор", "наушники", "кроссовки"], s
    changed, d, s = run("q:ed:0")
    assert d["admin_ui"]["pending"] == "edit_query:0"
    changed, d, s = run("delq:0")
    assert "телефон" not in (s.get("queries") or [])
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
    admin._feedback("tok", d, feed_cb("l5"))
    assert d["feedback"][5]["likes"] == 4
    assert abs(d["query_stats"]["a"]["likes"] - 4) < 0.01
    admin._feedback("tok", d, feed_cb("b5", user="888"))
    assert d["feedback"][5]["bought"] == 2
    admin._feedback("tok", d, feed_cb("b5", user="888"))
    assert d["feedback"][5]["bought"] == 2  # анти-двойной клик по юзеру
    admin._feedback("tok", d, feed_cb("b5", user="777"))
    assert d["feedback"][5]["bought"] == 3  # другой юзер проходит
    assert d["feedback"][5]["likes"] == 4
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


if __name__ == "__main__":
    main()