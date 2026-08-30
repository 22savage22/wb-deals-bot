import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import poller
import state


class FakeTG:
    sent = []

    @staticmethod
    def send_message(t, c, text, markup=None):
        FakeTG.sent.append((c, text))
        return True


def data_with(meta=None, recent=None):
    d = state._empty()
    d["meta"].update(meta or {})
    d["recent"] = recent or []
    return d


def main():
    poller.tg = FakeTG
    poller.config.TG_ADMIN_ID = "42"
    poller.config.TG_CHAT_ID = "CH"

    # --- 1. первый запуск поллера: дайджест не шлём, только запоминаем день ---
    data = data_with()
    FakeTG.sent = []
    poller._maybe_daily_digest("tok", data)
    assert data["meta"]["digest_date"] == time.strftime("%Y-%m-%d")
    assert FakeTG.sent == []
    print("1. first run no digest OK")

    # --- 2. наступил новый день -> админ получает отчёт ---
    now = int(time.time())
    data = data_with(
        meta={"digest_date": "2000-01-01"},
        recent=[{"pid": 1, "title": "Хит", "discount": 70, "ts": now - 60, "link": "l",
                 "cat": "c", "query": "q", "price": 1, "rating": 4}],
    )
    data["feedback"]["1"] = {"likes": 9, "dislikes": 1, "bought": 3, "ts": now - 10, "query": "q", "cat": "c"}
    FakeTG.sent = []
    poller._maybe_daily_digest("tok", data)
    assert len(FakeTG.sent) == 1 and FakeTG.sent[0][0] == "42"
    assert "Отчёт за сутки" in FakeTG.sent[0][1]
    assert "Хит" in FakeTG.sent[0][1]
    FakeTG.sent = []
    poller._maybe_daily_digest("tok", data)
    assert FakeTG.sent == []  # тот же день — повторно не шлём
    print("2. daily digest OK")

    # --- 3. недельный дайджест выключен -> тишина ---
    settings = {"weekly_digest": 0}
    poller.config.WEEKLY_DIGEST = 1
    FakeTG.sent = []
    poller._maybe_week_digest("tok", data, settings)
    assert FakeTG.sent == []
    print("3. weekly off OK")

    # --- 4. недельный дайджест включён -> пост в канал + отметка админу ---
    settings = {"weekly_digest": 1}
    FakeTG.sent = []
    poller._maybe_week_digest("tok", data, settings)
    assert len(FakeTG.sent) == 2, FakeTG.sent
    channel, admin_msg = FakeTG.sent[0], FakeTG.sent[1]
    assert channel[0] == "CH" and "Итоги недели" in channel[1]
    assert admin_msg[0] == "42" and "Итоги недели" in admin_msg[1]
    assert "очередь" in admin_msg[1] and "Чаще всего" in admin_msg[1]
    assert data["meta"]["week_digest_ts"] > 0
    FakeTG.sent = []
    poller._maybe_week_digest("tok", data, settings)
    assert FakeTG.sent == []  # раз в неделю
    print("4. weekly digest OK")

    # --- 5. неделя пустая -> ничего в канал, но время отмечаем ---
    data2 = data_with(recent=[{"pid": 2, "title": "Ст", "discount": 10, "ts": int(time.time()) - 20 * 86400}])
    FakeTG.sent = []
    poller._maybe_week_digest("tok", data2, settings)
    assert FakeTG.sent == []
    assert data2["meta"]["week_digest_ts"] > 0
    print("5. empty week OK")

    # --- 6. канал не ответил -> не отмечаем, повторим позже ---
    class FailingTG:
        @staticmethod
        def send_message(t, c, text, markup=None):
            FakeTG.sent.append((c, text))
            return False

    poller.tg = FailingTG
    data3 = data_with(recent=[{"pid": 3, "title": "Т", "discount": 50, "ts": int(time.time())}])
    FakeTG.sent = []
    poller._maybe_week_digest("tok", data3, settings)
    assert data3["meta"].get("week_digest_ts") is None
    assert len(FakeTG.sent) == 1
    print("6. retry on failure OK")

    # --- 7. admin не задан -> дайджест пропускается, день всё равно фиксируется ---
    poller.tg = FakeTG
    poller.config.TG_ADMIN_ID = ""
    data4 = data_with()
    FakeTG.sent = []
    poller._maybe_daily_digest("tok", data4)
    assert FakeTG.sent == []
    assert data4["meta"]["digest_date"] == time.strftime("%Y-%m-%d")
    print("7. no-admin OK")


if __name__ == "__main__":
    main()
