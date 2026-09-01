import random
import time
from io import BytesIO

import requests
from PIL import Image

import config

SESSION = requests.Session()
SESSION.headers.update(
    {
        "User-Agent": config.UA,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "ru-RU,ru;q=0.9",
    }
)

SEARCH = "https://search.wb.ru/exactmatch/ru/common/v9/search"
CATALOG = "https://catalog.wb.ru/catalog"
CARDS = "https://card.wb.ru/cards/v4/detail"
MENU_URL = "https://static-basket-01.wbbasket.ru/vol0/data/main-menu-ru-ru-v3.json"
MENU_FALLBACKS = [
    "https://static-basket-02.wbbasket.ru/vol0/data/main-menu-ru-ru-v3.json",
    "https://static-basket-01.wbbasket.ru/vol0/data/main-menu-ru-ru-v2.json",
    "https://static-basket-02.wbbasket.ru/vol0/data/main-menu-ru-ru-v2.json",
]

_HOSTS = {}
FORMAT_FAILS = 0
HTTP_STATS = {}


def reset_health():
    global FORMAT_FAILS, HTTP_STATS
    FORMAT_FAILS = 0
    HTTP_STATS = {
        "calls": 0,
        "ok": 0,
        "rate_limited": 0,
        "http_error": 0,
        "network_error": 0,
        "json_error": 0,
    }


def health_snapshot():
    return dict(HTTP_STATS)


reset_health()


def _get(url, params=None, tries=3):
    sleeps = (5, 15, 30)
    for attempt in range(tries):
        HTTP_STATS["calls"] += 1
        try:
            resp = SESSION.get(url, params=params, timeout=25)
            if resp.status_code == 200:
                try:
                    data = resp.json()
                    HTTP_STATS["ok"] += 1
                    return data
                except ValueError:
                    HTTP_STATS["json_error"] += 1
                    return None
            if resp.status_code == 429:
                HTTP_STATS["rate_limited"] += 1
                wait = sleeps[min(attempt, len(sleeps) - 1)]
                retry_after = resp.headers.get("Retry-After")
                if retry_after and str(retry_after).isdigit():
                    wait = min(60, max(wait, int(retry_after)))
                time.sleep(wait + random.uniform(0, 4))
                continue
            HTTP_STATS["http_error"] += 1
            return None
        except requests.RequestException:
            HTTP_STATS["network_error"] += 1
        time.sleep(3 + attempt * 3)
    return None


def search(query, page, subject=None):
    params = {
        "appType": "1",
        "curr": "rub",
        "dest": str(config.DEST),
        "spp": "30",
        "lang": "ru",
        "query": query,
        "sort": "benefit",
        "page": str(page),
        "resultset": "catalog",
        "ab_testing": "false",
        "suppressSpellcheck": "false",
    }
    global FORMAT_FAILS
    for attempt in range(3):
        url = f"{CATALOG}/{subject}/catalog" if subject else SEARCH
        data = _get(url, params)
        if not data:
            return []
        products = (data.get("data") or {}).get("products")
        if products is None:
            products = data.get("products")
        if products is not None:
            FORMAT_FAILS = 0
            if products or not subject:
                return products
            # категория не отдала товары по subject — пробуем текстовый поиск
            products = _search_plain(query, page)
            return products or []
        time.sleep(5 + attempt * 10)
    FORMAT_FAILS += 1
    return []


def _search_plain(query, page):
    params = {
        "appType": "1",
        "curr": "rub",
        "dest": str(config.DEST),
        "spp": "30",
        "lang": "ru",
        "query": query,
        "sort": "benefit",
        "page": str(page),
        "resultset": "catalog",
        "ab_testing": "false",
        "suppressSpellcheck": "false",
    }
    data = _get(SEARCH, params)
    if not data:
        return []
    products = (data.get("data") or {}).get("products")
    if products is None:
        products = data.get("products")
    return products or []


def _parse_menu(data):
    """Плоский список категорий: [(name, shard)] — без blackhole и пустых."""
    out = []
    seen = set()

    def walk(node):
        if isinstance(node, list):
            for item in node:
                walk(item)
            return
        if not isinstance(node, dict):
            return
        name = node.get("name")
        shard = node.get("shard") or ""
        if (
            name
            and isinstance(name, str)
            and name.strip()
            and shard
            and shard != "blackhole"
        ):
            key = name.strip()
            if key not in seen:
                seen.add(key)
                out.append((key, str(shard)))
        for key in ("childs", "children"):
            for child in node.get(key) or []:
                walk(child)

    if isinstance(data, dict):
        data = data.get("data") or data
    walk(data)
    return out


def menu():
    for url in [MENU_URL] + MENU_FALLBACKS:
        data = _get(url, tries=1)
        if data:
            parsed = _parse_menu(data)
            if parsed:
                return parsed
    return []


def search_healthy():
    return FORMAT_FAILS < 3


def _has_price(card):
    for size in card.get("sizes") or []:
        p = size.get("price") or {}
        if p.get("product") and p.get("basic"):
            return True
    return False


def _cards_chunk(ids, dest):
    data = _get(
        CARDS,
        params={
            "appType": "1",
            "curr": "rub",
            "dest": str(dest),
            "spp": "30",
            "nm": ";".join(str(x) for x in ids),
        },
    )
    return (data or {}).get("products") or []


def cards(ids):
    result = []
    for i in range(0, len(ids), 20):
        chunk = ids[i : i + 20]
        prods = _cards_chunk(chunk, config.DEST)
        missing = [p for p in prods if not _has_price(p)]
        if missing:
            for d2 in config.FALLBACK_DESTS:
                if not missing:
                    break
                alt = _cards_chunk([p.get("id") for p in missing], d2)
                by_id = {p.get("id"): p for p in alt}
                for j, p in enumerate(prods):
                    rep = by_id.get(p.get("id"))
                    if rep is not None and _has_price(rep):
                        prods[j] = rep
                missing = [p for p in prods if not _has_price(p)]
        result.extend(prods)
        time.sleep(random.uniform(0.3, 0.8))
    return result


def _out_of_stock(card):
    sizes = card.get("sizes") or []
    if not sizes:
        return False
    qtys = [s.get("qty") for s in sizes if s.get("qty") is not None]
    if not qtys:
        return False
    return sum(qtys) <= 0


def _blacklisted(d):
    bl = config.BLACKLIST or []
    if not bl:
        return False
    pid = str(d.get("id") or "")
    brand = str(d.get("brand") or "").lower()
    return any(x and (x == pid or x in brand) for x in bl)


def raw_deal(card):
    sizes = card.get("sizes") or []
    best = None
    for size in sizes:
        p = size.get("price") or {}
        product = p.get("product") or 0
        basic = p.get("basic") or 0
        if not product or not basic:
            continue
        product_rub = product // 100
        basic_rub = basic // 100
        if basic_rub <= 0:
            continue
        if best is None or product_rub < best[0]:
            best = (product_rub, basic_rub)
    if best is None:
        product = basic = discount = benefit = 0
    else:
        product, basic = best
        discount = round(100 - product * 100 / basic)
        benefit = basic - product
    rating = card.get("reviewRating") or card.get("rating") or 0
    return {
        "id": card.get("id"),
        "title": card.get("name") or "",
        "brand": card.get("brand") or "",
        "product": product,
        "basic": basic,
        "discount": discount,
        "benefit": benefit,
        "rating": rating,
        "feedbacks": card.get("feedbacks") or card.get("nmFeedbacks") or 0,
        "category": str(
            card.get("subjectName") or card.get("subject") or "другое"
        ).strip(),
    }


def evaluate(card, min_discount=None, min_rating=None, min_feedbacks=0):
    """Return ``(deal, reason)`` so an empty run can be explained."""
    d = raw_deal(card)
    if (
        not d["id"]
        or d["product"] <= 0
        or d["basic"] <= d["product"]
    ):
        return None, "bad_price"
    if _out_of_stock(card):
        return None, "out_of_stock"
    if _blacklisted(d):
        return None, "blacklist"
    min_discount = config.MIN_DISCOUNT if min_discount is None else min_discount
    min_rating = config.MIN_RATING if min_rating is None else min_rating
    if d["discount"] < min_discount:
        return None, "discount"
    if config.MAX_PRICE and d["product"] > config.MAX_PRICE:
        return None, "max_price"
    if min_rating and d["rating"] < min_rating:
        return None, "rating"
    if min_feedbacks and d["feedbacks"] < min_feedbacks:
        return None, "feedbacks"
    return d, "ok"


def deal(card, min_discount=None, min_rating=None, min_feedbacks=0):
    return evaluate(card, min_discount, min_rating, min_feedbacks)[0]


def deal_from_search(item, min_discount=None, min_rating=None, min_feedbacks=0):
    return deal(
        {
            "id": item.get("id"),
            "name": item.get("name"),
            "brand": item.get("brand"),
            "sizes": item.get("sizes") or [],
            "rating": item.get("reviewRating") or item.get("rating") or 0,
            "feedbacks": item.get("feedbacks") or item.get("nmFeedbacks") or 0,
            "subjectName": item.get("subjectName"),
            "subject": item.get("subject"),
        },
        min_discount=min_discount,
        min_rating=min_rating,
        min_feedbacks=min_feedbacks,
    )


def _http_ok(url):
    try:
        with SESSION.get(url, timeout=8, stream=True) as resp:
            return resp.status_code == 200
    except requests.RequestException:
        return False


def _basket_host(nm):
    vol = nm // 100000
    part = nm // 1000
    cached = _HOSTS.get(vol)
    if cached:
        return cached
    for i in range(1, 61):
        host = f"{i:02d}"
        probe = f"https://basket-{host}.wbbasket.ru/vol{vol}/part{part}/{nm}/info/ru/card.json"
        if _http_ok(probe):
            _HOSTS[vol] = host
            return host
    return None


def _fetch_photo(url):
    try:
        resp = SESSION.get(url, timeout=20)
        if resp.status_code != 200:
            return None
        img = Image.open(BytesIO(resp.content))
        if img.mode != "RGB":
            img = img.convert("RGB")
        img.thumbnail((1280, 1280))
        buf = BytesIO()
        img.save(buf, format="JPEG", quality=88)
        buf.seek(0)
        return buf
    except Exception:
        return None


def photos(nm, limit=3):
    host = _basket_host(nm)
    if not host:
        return []
    vol = nm // 100000
    part = nm // 1000
    base = f"https://basket-{host}.wbbasket.ru/vol{vol}/part{part}/{nm}/images"
    out = []
    for idx in range(1, limit + 1):
        buf = _fetch_photo(f"{base}/big/{idx}.webp")
        if buf is None:
            for path in (f"c516x688/{idx}.webp", f"c246x328/{idx}.webp"):
                buf = _fetch_photo(f"{base}/{path}")
                if buf is not None:
                    break
        if buf is None:
            break
        if out and image_hash(buf) == image_hash(out[0]):
            continue
        out.append(buf)
    return out


def photo(nm):
    out = photos(nm, 1)
    return out[0] if out else None


def hamming(a, b):
    """Расстояние Хэмминга между двумя dHash-строками."""
    try:
        return bin(int(a, 16) ^ int(b, 16)).count("1")
    except (ValueError, TypeError):
        return 2**32


def image_hash(buf):
    """Перцептивный хэш картинки (dHash 9x8): один и тот же товар
    под разными артикулами даёт одинаковый хэш."""
    try:
        original_pos = buf.tell()
    except (AttributeError, OSError):
        original_pos = None
    try:
        buf.seek(0)
        img = Image.open(buf).convert("L").resize((9, 8), Image.BILINEAR)
        px = list(img.getdata())
        bits = 0
        for y in range(8):
            for x in range(8):
                bits = (bits << 1) | (px[y * 9 + x] > px[y * 9 + x + 1])
        return format(bits, "016x")
    except Exception:
        return None
    finally:
        if original_pos is not None:
            try:
                buf.seek(original_pos)
            except (AttributeError, OSError):
                pass
