import os
import sys
import time

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
        return []

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
    def deal_from_search(item):
        sizes = item.get("sizes") or []
        price = sizes[0]["price"] if sizes else {}
        product = price.get("product", 0) // 100
        basic = price.get("basic", 0) // 100
        if basic > product:
            discount = round(100 - product * 100 / basic)
        else:
            discount = 0
        return {
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

    @staticmethod
    def photo(nm):
        return FakeWB.photo_map.get(nm, b"jpeg-%d" % nm)

    @staticmethod
    def photos(nm, limit=3):
        return [FakeWB.photo(nm)]

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

    cfg = config
    config.TG_ADMIN_ID = "42"
    config.TG_BOT_TOKEN = "tok"

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
    print("4. empty feed OK")

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
            "name": "Кроссовки летние" if i < 3 else "Наушники беспроводные",
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