import json
import os


def _int(name, default):
    raw = os.getenv(name)
    try:
        return int(raw) if raw not in (None, "") else default
    except ValueError:
        return default


def _float(name, default):
    raw = os.getenv(name)
    try:
        return float(raw) if raw not in (None, "") else default
    except ValueError:
        return default


TG_BOT_TOKEN = os.getenv("TG_BOT_TOKEN", "")
TG_CHAT_ID = os.getenv("TG_CHAT_ID", "")
TG_ADMIN_ID = os.getenv("TG_ADMIN_ID", "")

DEST = _int("WB_DEST", -1257786)
MIN_DISCOUNT = _int("WB_MIN_DISCOUNT", 50)
MAX_PRICE = _int("WB_MAX_PRICE", 0)
MIN_RATING = _float("WB_MIN_RATING", 0)
MAX_POSTS = _int("WB_MAX_POSTS", 5)
PAGES = _int("WB_PAGES", 1)
REPOST_DAYS = _float("WB_REPOST_DAYS", 7)
QUERIES_PER_RUN = _int("WB_QUERIES_PER_RUN", 4)
WEEKLY_DIGEST = _int("WB_WEEKLY_DIGEST", 1)
STATE_FILE = os.getenv("WB_STATE_FILE", "state.json")
QUEUE_FILE = os.getenv("WB_QUEUE_FILE", "queue.json")
SETTINGS_FILE = os.getenv("WB_SETTINGS_FILE", "settings.json")
PRICE_DROP_MIN = _float("WB_PRICE_DROP_MIN", 0.15)
HAMMING_MAX = _int("WB_HAMMING_MAX", 6)
CATS_PER_RUN = _int("WB_CATS_PER_RUN", 2)
CATS_RETIRE_EMPTY = _int("WB_CATS_RETIRE_EMPTY", 5)
CATS_REACTIVATE_DAYS = _float("WB_CATS_REACTIVATE_DAYS", 14)
SMART_FALLBACK = _int("WB_SMART_FALLBACK", 1)
FALLBACK_MIN_DISCOUNT = _int("WB_FALLBACK_MIN_DISCOUNT", 40)
FALLBACK_MIN_RATING = _float("WB_FALLBACK_MIN_RATING", 4.3)
FALLBACK_MIN_FEEDBACKS = _int("WB_FALLBACK_MIN_FEEDBACKS", 20)
USE_ALBUMS = _int("TG_USE_ALBUMS", 0)
QUEUE_TARGET = _int("WB_QUEUE_TARGET", 30)
QUEUE_MAX_AGE_HOURS = _float("WB_QUEUE_MAX_AGE_HOURS", 8)
RESERVE_MIN_DISCOUNT = _int("WB_RESERVE_MIN_DISCOUNT", 30)
RESERVE_MIN_RATING = _float("WB_RESERVE_MIN_RATING", 4.5)
RESERVE_MIN_FEEDBACKS = _int("WB_RESERVE_MIN_FEEDBACKS", 200)
ACTIVE_HOUR_START = _int("WB_ACTIVE_HOUR_START", 6)
ACTIVE_HOUR_END = _int("WB_ACTIVE_HOUR_END", 22)
FORCE_POST = _int("WB_FORCE_POST", 0)

FALLBACK_DESTS = [
    int(x.strip())
    for x in os.getenv("WB_FALLBACK_DESTS", "123585633,-1").split(",")
    if x.strip().lstrip("-").isdigit()
]

BLACKLIST = [
    x.strip().lower()
    for x in os.getenv("WB_BLACKLIST", "").split(",")
    if x.strip()
]

CATEGORY_BLOCKLIST = [
    x.strip().lower()
    for x in os.getenv(
        "WB_CATEGORY_BLOCKLIST", "18+;эротические товары;табак;вейпы"
    ).split(";")
    if x.strip()
]

LINK_TEMPLATE = os.getenv(
    "WB_LINK_TEMPLATE",
    "https://www.wildberries.ru/catalog/{nm}/detail.aspx",
)

DEFAULT_QUERIES = [
    "телефон",
    "наушники",
    "телевизор",
    "кроссовки",
]

QUERIES = [q.strip() for q in os.getenv("WB_QUERIES", "").split(";") if q.strip()]

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"


def load_settings(path=SETTINGS_FILE):
    if not os.path.exists(path):
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def save_settings(data, path=SETTINGS_FILE):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def apply(settings):
    if settings.get("min_discount") is not None:
        globals()["MIN_DISCOUNT"] = float(settings["min_discount"])
    if settings.get("min_rating") is not None:
        globals()["MIN_RATING"] = float(settings["min_rating"])
    if settings.get("max_price") is not None:
        globals()["MAX_PRICE"] = float(settings["max_price"])
    if settings.get("max_posts") is not None:
        globals()["MAX_POSTS"] = int(settings["max_posts"])
    if settings.get("pages") is not None:
        globals()["PAGES"] = int(settings["pages"])
    if settings.get("queries_per_run") is not None:
        globals()["QUERIES_PER_RUN"] = int(settings["queries_per_run"])
    if settings.get("repost_days") is not None:
        globals()["REPOST_DAYS"] = float(settings["repost_days"])
    if settings.get("dest") is not None:
        globals()["DEST"] = int(settings["dest"])
    q = settings.get("queries")
    if isinstance(q, str):
        q = [x.strip() for x in q.split(",") if x.strip()]
    if q:
        globals()["QUERIES"] = q
    if settings.get("link_template"):
        globals()["LINK_TEMPLATE"] = settings["link_template"]
    if settings.get("weekly_digest") is not None:
        globals()["WEEKLY_DIGEST"] = int(settings["weekly_digest"])
    b = settings.get("blacklist")
    if isinstance(b, str):
        b = [x.strip() for x in b.split(",") if x.strip()]
    if b:
        globals()["BLACKLIST"] = [str(x).strip().lower() for x in b]
    d = settings.get("fallback_dests")
    if isinstance(d, str):
        d = [int(x.strip()) for x in d.split(",") if x.strip().lstrip("-").isdigit()]
    if d:
        globals()["FALLBACK_DESTS"] = [int(x) for x in d]
    if settings.get("price_drop_min") is not None:
        globals()["PRICE_DROP_MIN"] = float(settings["price_drop_min"])
    if settings.get("cats_per_run") is not None:
        globals()["CATS_PER_RUN"] = int(settings["cats_per_run"])
