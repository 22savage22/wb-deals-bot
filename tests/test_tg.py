import json
import sys
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import tg


def _deal(pid, title="Товар <script>alert(1)</script> & Ко", category="Электроника", brand="Samsung"):
    return {
        "id": pid,
        "title": title,
        "brand": brand,
        "product": 12990,
        "basic": 19990,
        "discount": 35,
        "benefit": 7000,
        "rating": 4.7,
        "feedbacks": 150,
        "category": category,
    }


def main():
    # 1. детерминированность: один pid -> одна и та же подпись
    a1 = tg.caption(_deal(42), 42)
    a2 = tg.caption(_deal(42), 42)
    assert a1 == a2, (a1, a2)
    print("1. deterministic OK")

    # 2. базовые элементы подписи
    c = tg.caption(_deal(12345), 12345)
    assert "12 990" in c and "19 990" in c
    assert "-35%" in c
    assert any(c.startswith(emoji) for emoji, _ in tg.OPENERS)
    assert "<script>" not in c  # экранировано
    assert "&lt;script&gt;" in c
    assert "#вайлдберриз" in c and "#скидки" in c
    assert "#электроника" in c  # хештег категории
    assert "#samsung" in c  # хештег бренда
    assert "СКИДКА <b>" not in c  # старый формат убран
    print("2. content OK")

    # 3. плохие категории не дают хештеги
    c = tg.caption(_deal(7, category="другое", brand=""), 7)
    assert "#другое" not in c
    print("3. bad tags OK")

    # 4. вариативность: на 30 пидах есть минимум 5 разных открывалок
    openers = set()
    for pid in range(100, 130):
        c = tg.caption(_deal(pid), pid)
        openers.add(c.split("\n")[0])
    assert len(openers) >= 5, openers
    print("4. variety OK (%d openers)" % len(openers))

    # 5. _pick всегда в границах списка
    for pid in range(0, 500):
        assert tg._pick(pid, tg.OPENERS) in tg.OPENERS
        assert tg._pick(pid, tg.PRICE_WORDS) in tg.PRICE_WORDS
        assert tg._pick(pid, [0, 1]) in (0, 1)
    print("5. _pick bounds OK")

    # 6. длина капшена не превышает лимит telegram (1024)
    long = tg.caption(_deal(1, title="X" * 400), 1)
    assert len(long) <= 1024, len(long)
    print("6. length OK")

    # 7. обёртка клавиатуры
    kb = tg._kb([[{"text": "A", "callback_data": "a"}]])
    assert kb == {"inline_keyboard": [[{"text": "A", "callback_data": "a"}]]}
    assert tg._kb({"inline_keyboard": []}) == {"inline_keyboard": []}
    print("7. kb wrap OK")

    # 8. fmt
    assert tg.fmt(1234567) == "1 234 567"
    assert tg.fmt(5) == "5"
    print("8. fmt OK")

    # 9. подпись без pid (атрибут id из сделки)
    c = tg.caption(_deal(99))
    assert c == tg.caption(_deal(99))
    print("9. pid fallback OK")

    # 10. подпись для падения цены
    d = _deal(5)
    d["price_drop"] = True
    d["last_price"] = 20000
    c = tg.caption(d, 5)
    assert "Цена упала ещё ниже" in c
    assert "20 000" in c and "12 990" in c
    assert "<s>20 000</s>" in c
    assert len(c) <= 1024
    print("10. price drop caption OK")


if __name__ == "__main__":
    main()
