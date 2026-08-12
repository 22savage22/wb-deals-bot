import os


def _int(name, default):
    raw = os.getenv(name)
    try:
        return int(raw) if raw not in (None, "") else default
    except ValueError:
        return default


TG_BOT_TOKEN = os.getenv("TG_BOT_TOKEN", "")
TG_CHAT_ID = os.getenv("TG_CHAT_ID", "")

DEST = _int("WB_DEST", -1257786)
MIN_DISCOUNT = _int("WB_MIN_DISCOUNT", 50)
MAX_PRICE = _int("WB_MAX_PRICE", 0)
MIN_RATING = _int("WB_MIN_RATING", 0)
MAX_POSTS = _int("WB_MAX_POSTS", 5)
PAGES = _int("WB_PAGES", 1)
STATE_FILE = os.getenv("WB_STATE_FILE", "state.json")

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
