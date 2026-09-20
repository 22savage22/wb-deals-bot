"""Public product data only: never export bot state or Telegram identities."""
import math
import re
from urllib.parse import urlparse

SLOTS = {
    "dress": "Платье", "top": "Верх", "bottom": "Низ", "shoes": "Обувь",
    "bag": "Сумка", "jewelry": "Украшения", "belt": "Ремень",
    "hat": "Головной убор", "outer": "Верхняя одежда", "other": "Другое",
}
MARKERS = {
    "belt": ("ремень", "ремни", "пояс"),
    "dress": ("плать", "сарафан"),
    "outer": ("куртк", "пальто", "пуховик", "тренч", "плащ"),
    "bottom": ("юбк", "джинс", "брюк", "шорт", "леггин"),
    "shoes": ("кроссов", "кед", "туфл", "ботин", "сапог", "лофер", "босонож", "балетк"),
    "bag": ("сумк", "рюкзак", "клатч"),
    "jewelry": ("серьг", "украшен", "кольц", "брасл", "ожерел", "кулон", "колье", "чокер", "цепоч", "брошь", "подвеск"),
    "hat": ("кепк", "шапк", "шляп", "панам", "бейсбол"),
    "top": ("футбол", "блуз", "рубаш", "топ", "свитер", "кардиган", "джемпер", "худи", "кофт", "жакет", "свитшот"),
}
OCCASIONS = {"everyday": "На каждый день", "office": "В офис", "evening": "На вечер"}
UNSUITABLE = re.compile(r"детск|девоч|мальчик|малыш|кукл|игруш|постель|подуш|штор|ковр|коврик|чехол|для мебели|для дома|домашн|пижам|ночнуш|бель[её]|бюстгальтер|трус|купаль|плавк|карнавал|косплей|костюмирован|униформ|спецодеж|медицин")


def style(p):
    """Only explicit description signals; unknown is not visual validation."""
    text = (p["title"] + " " + p.get("category", "")).lower()
    return {"eligible": not UNSUITABLE.search(text),
            "sport": bool(re.search(r"спортив|бегов|фитнес|трениров|леггин|худи|свитшот", text)),
            "sneakers": bool(re.search(r"кроссов|кеды", text)),
            "formal": bool(re.search(r"вечерн|коктейл|торжеств|атлас|пайет|смокинг", text)),
            "summer": bool(re.search(r"летн|босонож|сандал|шорт|сарафан", text)),
            "winter": bool(re.search(r"зимн|утеплен|утеплён|пухов|мехов", text)),
            "color": {c for c, pattern in (("red", r"красн|бордов"), ("pink", r"розов"), ("blue", r"голуб|син[ияе]"), ("green", r"зел[её]н|изумруд"), ("yellow", r"ж[её]лт|оранж"), ("purple", r"фиолет|сирен")) if re.search(pattern, text)}}


def safe_image(value):
    value = str(value or "")[:1000]
    parsed = urlparse(value)
    if parsed.scheme == "https" and re.fullmatch(r"basket-\d{2,3}\.wbbasket\.ru", parsed.hostname or ""):
        if not parsed.username and not parsed.password and parsed.port in (None, 443):
            return value
    return ""


def normalize(raw):
    pid = int(raw.get("id") or raw.get("pid") or 0)
    price = float(raw.get("price") or raw.get("product") or 0)
    if not 0 < pid < 10**12 or not math.isfinite(price) or not 0 < price <= 10**7:
        raise ValueError("Некорректный товар")
    title = str(raw.get("title") or "").strip()[:200]
    if not title:
        raise ValueError("Нет названия")
    category = str(raw.get("category") or raw.get("cat") or raw.get("query") or "")[:100]
    text = (title + " " + category).lower()
    # Prefer the real category over mentions like "ремень для платья" in a title.
    slot = next((s for s, markers in MARKERS.items() if any(m in category.lower() for m in markers)), None)
    if slot is None:
        slot = next((s for s, markers in MARKERS.items() if any(m in title.lower() for m in markers)), "other")
    if UNSUITABLE.search(text):
        slot = "other"
    audience = "men" if "мужск" in text and "женск" not in text else "women" if "женск" in text else "unknown"
    rating = float(raw.get("rating") or 0)
    checked = int(raw.get("checked_at") or raw.get("ts") or raw.get("queued_ts") or 0)
    return {
        "id": pid, "title": title, "price": round(price, 2), "category": category,
        "image": safe_image(raw.get("image")), "slot": slot, "audience": audience,
        "rating": min(5, max(0, rating)) if math.isfinite(rating) else 0,
        "checked_at": max(0, checked),
        "url": f"https://www.wildberries.ru/catalog/{pid}/detail.aspx",
    }
