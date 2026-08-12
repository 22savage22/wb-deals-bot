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
STATE_FILE = os.getenv("WB_STATE_FILE", "state.json")
SETTINGS_FILE = os.getenv("WB_SETTINGS_FILE", "settings.json")

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
    q = settings.get("queries")
    if isinstance(q, str):
        q = [x.strip() for x in q.split(",") if x.strip()]
    if q:
        globals()["QUERIES"] = q
    if settings.get("link_template"):
        globals()["LINK_TEMPLATE"] = settings["link_template"]