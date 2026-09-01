import os
import os
import sys
import time
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import bot
import config
import smart
import tg as tgmod
import state


class FakeTG:
    sent = []

    @staticmethod
    def send_message(t, c, text, markup=None):
        FakeTG.sent.append(("msg", c, text))
        return True

    @staticmethod
    def send_photo(t, c, photo, text, link=None, pid=None, markup=None):
        FakeTG.sent.append(("photo", c, pid, text))
        return True

    @staticmethod
    def send_album(t, c, photos, text, link=None, pid=None, markup=None):
        FakeTG.sent.append(("photo", c, pid, text))
        return True

    @staticmethod
    def fmt(n):
        return f"{n:,}".replace(",", " ")

    @staticmethod
    def caption(d, pid=None):
        return "%d%% %s #%s" % (d["discount"], d["title"], pid)


class FakeWB:
    items = {}
    photo_map = {}
    cat_menu = []
    search_subject_only = False
    health = {"calls": 1, "ok": 1}

    @staticmethod
    def reset_health():
        FakeWB.health = {"calls": 1, "ok": 1}

    @staticmethod
    def health_snapshot():
        return dict(FakeWB.health)

    @staticmethod
    def search(query, page, subject=None):
        if FakeWB.search_subject_only and subject is None:
            return []
        return list(FakeWB.items.values())

    @staticmethod
    def menu():
        return list(FakeWB.cat_menu)

    @staticmethod
    def cards(ids):
        return [FakeWB.items[pid] for pid in ids if pid in FakeWB.items]

    @staticmethod
    def search_healthy():
        return True

    @staticmethod
    def hamming(a, b):
        try:
            return bin(int(a, 16) ^ int(b, 16)).count("1")
        except (ValueError, TypeError):
            return 2**32

    @staticmethod
    def deal_from_search(item, min_discount=None, min_rating=None, min_feedbacks=0):
        sizes = item.get("sizes") or []
        price = sizes[0]["price"] if sizes else {}
        product = price.get("product", 0) // 100
        basic = price.get("basic", 0) // 100
        if basic > product:
            discount = round(100 - product * 100 / basic)
        else:
            discount = 0
        deal = {
            "id": item["id"],
            "title": item["name"],
            "brand": item.get("brand", ""),
            "product": product,
            "basic": basic,
            "discount": discount,
            "benefit": basic - product,
            "rating": item.get("reviewRating", 0),
            "feedbacks": item.get("feedbacks", 0),
            "category": item.get("subjectName", "другое"),
        }
        min_discount = config.MIN_DISCOUNT if min_discount is None else min_discount
        min_rating = config.MIN_RATING if min_rating is None else min_rating
        if discount < min_discount or (min_rating and deal["rating"] < min_rating):
            return None
        if min_feedbacks and deal["feedbacks"] < min_feedbacks:
            return None
        return deal

    @staticmethod
    def evaluate(item, min_discount=None, min_rating=None, min_feedbacks=0):
        deal = FakeWB.deal_from_search(item, min_discount, min_rating, min_feedbacks)
        if deal:
            return deal, "ok"
        return None, "discount"

    @staticmethod
    def photo(nm):
        return FakeWB.photo_map.get(nm, b"jpeg-%d" % nm)

    @staticmethod
    def photos(nm, limit=3):
        return [FakeWB.photo(nm), FakeWB.photo(nm + 100000), FakeWB.photo(nm + 200000)]

    @staticmethod
    def image_hash(buf):
        import hashlib

        return hashlib.sha1(buf).hexdigest()[:16]


def make_items(n=12, start=1000):
    items = {}
    for i in range(n):
        pid = start + i
        cat = "Кат%d" % (i % 6)
        items[pid] = {
            "id": pid,
            "name": "Товар %d" % pid,
            "brand": "Бр",
            "sizes": [{"price": {"product": (1200 - i) * 100, "basic": 2000 * 100}}],
            "reviewRating": 4.6,
            "feedbacks": 10,
            "subjectName": cat,
        }
    return items


def empty_data():
    d = state._empty()
    d["meta"]["today"] = time.strftime("%Y-%m-%d")
    return d


def main():
    bot.tg = FakeTG
    bot.wb = FakeWB
    bot.time.sleep = lambda s: None
    import wb as wbmod
    wbmod.photos = FakeWB.photos
    wbmod.image_hash = FakeWB.image_hash

    cfg = config
    config.TG_ADMIN_ID = "42"
    config.TG_BOT_TOKEN = "tok"

    # --- 0. расписание и публикация из заранее наполненной очереди ---
    old_start, old_end = config.ACTIVE_HOUR_START, config.ACTIVE_HOUR_END
    config.ACTIVE_HOUR_START, config.ACTIVE_HOUR_END = 0, 23
    assert bot.active_posting_time(datetime(2026, 1, 1, 0, 0))
    assert bot.active_posting_time(datetime(2026, 1, 1, 5, 59))
    assert bot.active_posting_time(datetime(2026, 1, 1, 6, 0))
    assert bot.active_posting_time(datetime(2026, 1, 1, 22, 59))
    assert bot.active_posting_time(datetime(2026, 1, 1, 23, 59))
    config.ACTIVE_HOUR_START, config.ACTIVE_HOUR_END = 6, 22
    assert not bot.active_posting_time(datetime(2026, 1, 1, 5, 59))
    assert not bot.active_posting_time(datetime(2026, 1, 1, 23, 0))
    config.ACTIVE_HOUR_START, config.ACTIVE_HOUR_END = old_start, old_end
    interval_data = {"recent": [{"ts": 1000}]}
    assert not bot.post_interval_elapsed(interval_data, now=1599)
    assert bot.post_interval_elapsed(interval_data, now=1600)
    runtime_keys = {
        "WB_MAX_POSTS": ("MAX_POSTS", 1),
        "WB_PAGES": ("PAGES", 2),
        "WB_QUERIES_PER_RUN": ("QUERIES_PER_RUN", 3),
        "WB_CATS_PER_RUN": ("CATS_PER_RUN", 4),
    }
    old_runtime = {name: getattr(config, name) for name, _ in runtime_keys.values()}
    try:
        for env, (name, value) in runtime_keys.items():
            os.environ[env] = str(value)
            setattr(config, name, value)
        config.apply({
            "max_posts": 9, "pages": 9, "queries_per_run": 9, "cats_per_run": 9,
        })
        assert all(getattr(config, name) == value for name, value in runtime_keys.values())
    finally:
        for env in runtime_keys:
            os.environ.pop(env, None)
        for name, value in old_runtime.items():
            setattr(config, name, value)
    queued = empty_data()
    queued_deal = {"id": 999, "title": "Товар из очереди", "brand": "Бр",
                   "product": 500, "basic": 1000, "discount": 50, "benefit": 500,
                   "rating": 4.8, "feedbacks": 300, "category": "Дом",
                   "selection_mode": "strict", "quality": "A", "query": "дом",
                   "queued_ts": int(time.time())}
    queued["queue"] = [queued_deal]
    FakeWB.items = {
        999: {
            "id": 999, "name": "Товар из очереди", "brand": "Бр",
            "sizes": [{"price": {"product": 50000, "basic": 100000}}],
            "reviewRating": 4.8, "feedbacks": 300, "subjectName": "Дом",
        }
    }
    config.MAX_POSTS = 1
    FakeTG.sent = []
    assert bot.run_posting(queued, {"queries": None}, notify=False) == 1
    assert queued["queue"] == [] and queued["posted"].get(999)
    assert [x for x in FakeTG.sent if x[0] == "photo" and x[2] == 999]
    queued["posted"][999] = int(time.time()) - 1000 * 86400
    queued["queue"] = [queued_deal]
    assert bot._publish_queued(queued, 1)[0] == 0
    print("0. schedule + queue publish OK")

    # --- 0a. перед публикацией очередь заново проверяется по свежей карточке WB ---
    stale = empty_data()
    stale["queue"] = [
        dict(queued_deal, id=901, title="Старая цена", query="дом"),
        dict(queued_deal, id=902, title="Старая карточка", query="кухня"),
    ]
    FakeWB.items = {
        901: {
            "id": 901, "name": "Больше не скидка", "brand": "Бр",
            "sizes": [{"price": {"product": 99000, "basic": 100000}}],
            "reviewRating": 4.8, "feedbacks": 300, "subjectName": "Дом",
        },
        902: {
            "id": 902, "name": "Свежая карточка", "brand": "Бр",
            "sizes": [{"price": {"product": 35000, "basic": 100000}}],
            "reviewRating": 4.9, "feedbacks": 500, "subjectName": "Кухня",
        },
    }
    FakeTG.sent = []
    published, deals, _ = bot._publish_queued(stale, 1)
    assert published == 1 and deals[0]["id"] == 902, deals
    assert stale["recent"][-1]["price"] == 350 and stale["recent"][-1]["rating"] == 4.9
    assert 901 not in [item["id"] for item in stale["queue"]]
    print("0a. queued deal live revalidation OK")

    # --- 0b. контроль простоя/очереди/повторных ошибок не спамит ---
    now = int(time.time())
    health = empty_data()
    health["recent"] = [{"pid": 1, "query": "дом", "ts": now - 1900}]
    health["queue"] = [dict(queued_deal, id=950 + i) for i in range(5)]
    health["meta"]["errors"] = [
        {"ts": now - i * 10, "msg": "сетевая ошибка"} for i in range(3)
    ]
    config.ACTIVE_HOUR_START, config.ACTIVE_HOUR_END = 0, 23
    FakeTG.sent = []
    assert len(bot._maybe_health_notices(health, {}, now)) == 3
    assert bot._maybe_health_notices(health, {}, now) == []
    paused = empty_data()
    paused["recent"] = [{"pid": 2, "ts": now - 1900}]
    paused["queue"] = [dict(queued_deal, id=970 + i) for i in range(6)]
    assert bot._maybe_health_notices(paused, {"pause_until": now + 60}, now) == []
    empty_history = empty_data()
    empty_history["queue"] = list(paused["queue"])
    assert bot._maybe_health_notices(empty_history, {}, now) == []
    assert "Товарных постов нет" in bot._maybe_health_notices(
        empty_history, {}, now + 1801
    )[0]
    config.ACTIVE_HOUR_START, config.ACTIVE_HOUR_END = old_start, old_end
    print("0b. health notices OK")

    # --- 0c. live-поиск тоже соблюдает суточный лимит темы ---
    old_search, old_cats = FakeWB.search, config.CATS_PER_RUN
    dress = make_items(1, 9800)[9800]
    dress["name"], dress["subjectName"] = "Платье", "платье женское"
    jeans = make_items(1, 9900)[9900]
    jeans["name"], jeans["subjectName"] = "Джинсы", "джинсы женские"
    for item in (dress, jeans):
        item["sizes"] = [{"price": {"product": 70000, "basic": 200000}}]
        item["feedbacks"] = 500
    FakeWB.items = {9800: dress, 9900: jeans}
    FakeWB.search = staticmethod(
        lambda query, page, subject=None: [] if subject else
        ([dress] if query == "платье женское" else [jeans])
    )
    capped = empty_data()
    capped["recent"] = [
        {"pid": 800 + i, "query": "платье женское", "ts": now - i * 60}
        for i in range(3)
    ]
    config.MAX_POSTS, config.PAGES, config.QUERIES_PER_RUN, config.CATS_PER_RUN = 1, 1, 2, 0
    FakeTG.sent = []
    assert bot.run_posting(
        capped, {"queries": ["платье женское", "джинсы женские"]}, notify=False
    ) == 1
    assert capped["recent"][-1]["pid"] == 9900
    FakeWB.search = staticmethod(old_search)
    config.CATS_PER_RUN = old_cats
    print("0c. live-search topic limit OK")

    # --- 1. обычный запуск: посты из разных категорий, отчёт админу ---
    config.MIN_DISCOUNT = 20
    config.MAX_PRICE = 0
    config.MIN_RATING = 0
    config.MAX_POSTS = 4
    config.PAGES = 1
    config.QUERIES_PER_RUN = 2
    config.REPOST_DAYS = 7
    FakeWB.items = make_items(12)
    FakeTG.sent = []
    data = empty_data()
    published = bot.run_posting(data, {"queries": None}, notify=True)
    assert published == 4, published
    cats = [r["cat"] for r in data["recent"]]
    assert len(set(cats)) == 4, cats  # ротация: 4 разных категории
    assert data["meta"]["last_posts"] == 4
    assert data["meta"]["total_posts"] == 4
    photos = [c for c in FakeTG.sent if c[0] == "photo"]
    assert len(photos) == 4
    msgs = [c[2] for c in FakeTG.sent if c[0] == "msg"]
    admin_msgs = [m for m in msgs if "Запуск завершён" in m]
    assert admin_msgs, msgs
    print("1. posting run OK")

    # --- 2. повторный запуск: уже опубликованное не дублируется ---
    first = dict(data["posted"])
    FakeTG.sent = []
    published = bot.run_posting(data, {"queries": None}, notify=True)
    kept = [p for p, ts in first.items() if data["posted"].get(p) == ts]
    assert kept == list(first), kept  # ни один товар из 1-го запуска не перепощен
    assert len(data["posted"]) == 4 + published
    # выдачу сведём к уже опубликованным: публиковать нечего
    data2 = empty_data()
    data2["posted"] = dict(first)
    FakeWB.items = {p: make_items(12)[p] for p in first}
    FakeTG.sent = []
    published2 = bot.run_posting(data2, {"queries": None}, notify=True)
    assert published2 == 0
    # уведомление «ничего не нашёл» приходит один раз (троттлинг 12ч)
    empty_msgs = [c for c in FakeTG.sent if c[0] == "msg" and "ничего не нашёл" in c[2]]
    assert len(empty_msgs) == 1
    FakeTG.sent = []
    bot.run_posting(data2, {"queries": None}, notify=True)
    empty_msgs = [c for c in FakeTG.sent if c[0] == "msg" and "ничего не нашёл" in c[2]]
    assert len(empty_msgs) == 0  # не спамим
    data2["meta"].pop("empty_notice_ts", None)
    FakeTG.sent = []
    bot.run_posting(data2, {"queries": None}, notify=True)
    empty_msgs = [c for c in FakeTG.sent if c[0] == "msg" and "ничего не нашёл" in c[2]]
    assert len(empty_msgs) == 1  # после сброса снова можно
    print("2. dedupe + empty notice OK")

    # --- 3. notify=False не шлёт отчёты (ручной запуск из поллера) ---
    data = empty_data()
    FakeWB.items = make_items(12)
    FakeTG.sent = []
    bot.run_posting(data, {"queries": None}, notify=False)
    msgs = [c for c in FakeTG.sent if c[0] == "msg"]
    assert msgs == [], msgs
    assert len([c for c in FakeTG.sent if c[0] == "photo"]) == 4
    print("3. notify=False OK")

    # --- 4. пауза не мешает, а пустая выдача - аккуратно ---
    FakeWB.items = {}
    data = empty_data()
    FakeTG.sent = []
    bot.run_posting(data, {"queries": None}, notify=True)
    empty_msgs = [m for m in FakeTG.sent if m[0] == "msg" and "ничего не нашёл" in m[2]]
    assert len(empty_msgs) == 1
    assert data["meta"]["last_run"] > 0
    assert data["meta"]["last_funnel"]["found"] == 0
    print("4. empty feed OK")

    # --- 4b. хорошая карточка проходит без выдуманного процента скидки ---
    config.MIN_DISCOUNT = 50
    config.MIN_RATING = 4.5
    config.FALLBACK_MIN_DISCOUNT = 40
    config.FALLBACK_MIN_RATING = 4.3
    config.FALLBACK_MIN_FEEDBACKS = 20
    candidate = make_items(1, 9000)[9000]
    candidate["sizes"][0]["price"] = {"product": 1100 * 100, "basic": 2000 * 100}
    candidate["feedbacks"] = 100
    funnel = {}
    found = bot._find_deals([candidate], 1, funnel)
    assert len(found) == 1 and found[0]["selection_mode"] == "good_price"
    assert found[0]["discount"] == 0 and found[0]["basic"] == found[0]["product"]
    assert funnel["strict"] == 0 and funnel["fallback"] == 1
    config.MIN_DISCOUNT = 20
    config.MIN_RATING = 0
    print("4b. smart fallback OK")

    # --- 5. pick_deals интегрирован: категория-изгой не постится ---
    FakeWB.items = make_items(12)
    data = empty_data()
    for r in ["Кат0", "Кат1"]:
        data["cat_stats"][r] = {"posts": 10, "likes": 1, "dislikes": 6, "bought": 0, "ts": 0}
    config.MAX_POSTS = 6
    FakeTG.sent = []
    published = bot.run_posting(data, {"queries": None}, notify=True)
    assert published == 6
    posted_cats = [r["cat"] for r in data["recent"]]
    assert "Кат0" not in posted_cats and "Кат1" not in posted_cats, posted_cats
    print("5. rejected categories OK")

    # --- 6. bump_meta и дайджест-данные пишутся ---
    assert data["meta"]["total_posts"] >= 6
    assert "Отчёт за сутки" in smart.admin_digest(data)
    assert "Итоги недели" in smart.week_digest(data)
    print("6. digest data OK")

    # --- 7. одинаковые названия не публикуются повторно (в рамках запуска и по памяти) ---
    items = {}
    for i in range(6):
        pid = 2000 + i
        items[pid] = {
            "id": pid,
            "name": "Кроссовки летние" if i < 3 else "Сумка женская",
            "brand": "Бр",
            "sizes": [{"price": {"product": (1500 - i) * 100, "basic": 2000 * 100}}],
            "reviewRating": 4.6,
            "feedbacks": 10,
            "subjectName": "другое",
        }
    FakeWB.items = items
    config.MAX_POSTS = 6
    data = empty_data()
    FakeTG.sent = []
    published = bot.run_posting(data, {"queries": None}, notify=True)
    titles_posted = [r["title"] for r in data["recent"]]
    assert len(set(titles_posted)) == 2, titles_posted  # только 2 уникальных названия
    assert published == 2, published
    print("7. title dedup OK")

    # --- 8. одинаковые фото (тот же товар под другим артикулом) не дублируются ---
    items = {}
    for i in range(6):
        pid = 3000 + i
        items[pid] = {
            "id": pid,
            "name": "Уникальный товар %d" % pid,
            "brand": "Бр",
            "sizes": [{"price": {"product": (1500 - i) * 100, "basic": 2000 * 100}}],
            "reviewRating": 4.6,
            "feedbacks": 10,
            "subjectName": "КатA",
        }
    FakeWB.items = items
    FakeWB.photo_map = {3000: b"same", 3001: b"same", 3002: b"same"}
    data = empty_data()
    FakeTG.sent = []
    published = bot.run_posting(data, {"queries": None}, notify=True)
    assert published == 4, published  # фото "same" + 3 разных: 4 уникальных картинки
    photos = [c for c in FakeTG.sent if c[0] == "photo"]
    assert len(photos) == 4, photos
    import hashlib

    assert hashlib.sha1(b"same").hexdigest()[:16] in data["img_hash"]
    assert 3000 not in data["img_hash"]
    # уже после поста повторный артикул той же картинки не публикуется
    FakeWB.photo_map = {3004: b"same"}
    FakeTG.sent = []
    bot.run_posting(data, {"queries": None}, notify=True)
    assert not [c for c in FakeTG.sent if c[0] == "photo"]
    print("8. image dedup OK")

    # --- 9. самообучение: разведка попадает в память, успешная — в ротацию ---
    data = empty_data()
    FakeWB.items = make_items(12)
    FakeWB.photo_map = {}
    FakeTG.sent = []
    bot.run_posting(data, {"queries": None}, notify=True)
    assert data["meta"].get("learn_ts"), "learn_categories не запустился"
    print("9. learning pipeline OK")

    # --- 10. падение цены: опубликованный товар репостится при скидке ещё ниже ---
    config.MAX_POSTS = 4
    items = {}
    for i in range(4):
        pid = 4000 + i
        items[pid] = {
            "id": pid,
            "name": "Ценовой товар %d" % pid,
            "brand": "Бр",
            "sizes": [{"price": {"product": 1000 * 100, "basic": 2000 * 100}}],
            "reviewRating": 4.6,
            "feedbacks": 10,
            "subjectName": "КатЦ",
        }
    FakeWB.items = items
    data = empty_data()
    FakeTG.sent = []
    published = bot.run_posting(data, {"queries": None}, notify=True)
    assert published == 4
    pid = 4000
    seen_at = int(time.time())
    data["prices"][pid]["samples"] = [
        [seen_at - 7200, 1000], [seen_at - 3600, 1000], [seen_at - 1800, 1000]
    ]
    items[pid]["sizes"][0]["price"]["product"] = 400 * 100  # -60% от базовой
    FakeTG.sent = []
    published2 = bot.run_posting(data, {"queries": None}, notify=True)
    assert published2 == 1, published2  # только падение цены прошло
    drops = [c for c in FakeTG.sent if c[0] == "photo" and c[2] == pid]
    assert len(drops) == 1
    assert data["prices"][pid]["price"] == 400
    # ещё раз тот же запуск — уже не дублируем (цена не падала дальше)
    FakeTG.sent = []
    bot.run_posting(data, {"queries": None}, notify=True)
    assert not [c for c in FakeTG.sent if c[0] == "photo"], FakeTG.sent
    # маленькое падение (10%) не триггерит
    items[pid]["sizes"][0]["price"]["product"] = 370 * 100
    FakeTG.sent = []
    bot.run_posting(data, {"queries": None}, notify=True)
    assert not [c for c in FakeTG.sent if c[0] == "photo"], FakeTG.sent
    # ещё 10% суммарно — 22.5% от базы 400 -> триггер
    items[pid]["sizes"][0]["price"]["product"] = 300 * 100
    FakeTG.sent = []
    bot.run_posting(data, {"queries": None}, notify=True)
    assert [c for c in FakeTG.sent if c[0] == "photo"], FakeTG.sent
    print("10. price drop repost OK")

    # --- 11. поиск по всем категориям каталога WB + самообучение ---
    config.CATS_PER_RUN = 1
    FakeWB.cat_menu = [("КатСмартфоны", "smartfony")]
    FakeWB.search_subject_only = True
    FakeWB.items = make_items(4)
    FakeWB.photo_map = {}
    data = empty_data()
    FakeTG.sent = []
    bot.run_posting(data, {"queries": None}, notify=True)
    assert data["meta"].get("last_cats") == ["КатСмартфоны"]
    st = data["cats"]["КатСмартфоны"]
    assert st["shard"] == "smartfony" and st["runs"] == 1
    # категория дала посты — пустота не копится, посты записаны под её именем
    assert st["empty"] == 0
    assert data["query_stats"]["КатСмартфоны"]["posts"] >= 1
    # второй запуск: та же категория, но уже пустая выдача
    FakeWB.items = {}
    FakeTG.sent = []
    bot.run_posting(data, {"queries": None}, notify=True)
    assert data["cats"]["КатСмартфоны"]["runs"] == 2
    assert data["cats"]["КатСмартфоны"]["empty"] == 1
    FakeWB.search_subject_only = False
    print("11. category search + learning OK")


if __name__ == "__main__":
    main()
