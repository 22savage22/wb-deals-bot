import os
import sys
from io import BytesIO

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import wb

import config
from PIL import Image


def card(pid=42, product=5500, basic=11000, rating=4.2, cat="Электроника", name="Тест"):
    return {
        "id": pid,
        "name": name,
        "brand": "B",
        "sizes": [{"price": {"product": product, "basic": basic}}],
        "reviewRating": rating,
        "feedbacks": 7,
        "subjectName": cat,
    }


def main():
    c = card()
    d = wb.raw_deal(c)
    assert (d["product"], d["basic"], d["discount"], d["benefit"], d["id"]) == (55, 110, 50, 55, 42)
    assert d["rating"] == 4.2 and d["category"] == "Электроника"
    print("1. raw_deal OK")

    # 2. фильтры deal()
    config.MIN_DISCOUNT = 60
    assert wb.deal(c) is None
    config.MIN_DISCOUNT = 40
    assert wb.deal(c)["discount"] == 50
    config.MIN_DISCOUNT = 50
    assert wb.deal(c)["discount"] == 50  # ровно 50% проходит («не меньше»)
    config.MIN_DISCOUNT = 51
    assert wb.deal(c) is None
    config.MIN_DISCOUNT = 45
    assert wb.deal(c)["discount"] == 50
    config.MIN_DISCOUNT = 50
    config.MAX_PRICE = 40
    assert wb.deal(c) is None
    config.MAX_PRICE = 100
    assert wb.deal(c)["product"] == 55
    config.MAX_PRICE = 0
    config.MIN_RATING = 4.5
    assert wb.deal(c) is None
    config.MIN_RATING = 0
    assert wb.deal(c)["rating"] == 4.2
    print("2. deal filters OK")

    # 3. битые карточки
    assert wb.deal({}) is None
    assert wb.deal({"id": 1, "name": "x", "sizes": [], "subjectName": "y"}) is None
    assert wb.raw_deal({"id": 1, "name": "x"})["product"] == 0
    print("3. broken cards OK")

    # 4. deal_from_search повторно использует логику
    item = {
        "id": 9,
        "name": "Т",
        "brand": "B",
        "sizes": [{"price": {"product": 1000, "basic": 2000}}],
        "reviewRating": 4.0,
        "feedbacks": 1,
        "subjectName": "Кат",
    }
    config.MIN_DISCOUNT = 50
    d = wb.deal_from_search(item)
    assert d and d["discount"] == 50 and d["id"] == 9
    print("4. deal_from_search OK")

    # 5. границы цен: basic <= product
    config.MAX_PRICE = 0
    c = card(product=11000, basic=11000)
    assert wb.deal(c) is None  # скидки нет
    c = card(product=22000, basic=11000)
    assert wb.deal(c) is None  # product > basic
    print("5. price edges OK")

    # 6. категория по умолчанию
    d = wb.raw_deal({"id": 1, "name": "x", "sizes": [{"price": {"product": 100, "basic": 200}}]})
    assert d["category"] == "другое"
    print("6. default category OK")

    config.MIN_DISCOUNT = 50
    config.MAX_PRICE = 0
    config.MIN_RATING = 0

    # 7. image_hash: одинаковые картинки -> одинаковый хэш, разные -> разные
    def make_img(mode):
        img = Image.new("RGB", (120, 80), (240, 240, 240))
        from PIL import ImageDraw

        d = ImageDraw.Draw(img)
        if mode == "red":
            d.rectangle([10, 10, 60, 70], fill=(200, 30, 30))
            d.ellipse([70, 20, 110, 60], fill=(30, 30, 200))
        elif mode == "red2":
            d.rectangle([10, 10, 60, 70], fill=(201, 31, 31))
            d.ellipse([70, 20, 110, 60], fill=(31, 31, 201))
        elif mode == "blue":
            d.rectangle([10, 10, 60, 70], fill=(30, 30, 200))
            d.ellipse([70, 20, 110, 60], fill=(200, 30, 30))
        else:
            d.rectangle([5, 5, 115, 75], fill=(50, 50, 50))
        buf = BytesIO()
        img.save(buf, "JPEG", quality=90)
        buf.seek(0)
        return buf

    h1 = wb.image_hash(make_img("red"))
    h1b = wb.image_hash(make_img("red2"))  # почти та же картинка
    h2 = wb.image_hash(make_img("blue"))
    h3 = wb.image_hash(make_img("dark"))
    assert h1 == h1b, (h1, h1b)
    assert h1 != h2 != h3, (h1, h2, h3)
    assert len(h1) == 16 and all(c in "0123456789abcdef" for c in h1)
    assert wb.image_hash("не картинка") is None
    print("7. image_hash OK")


if __name__ == "__main__":
    main()