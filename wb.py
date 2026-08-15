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


def _get(url, params=None, tries=5):
    sleeps = (10, 20, 30, 45, 60)
    for attempt in range(tries):
        try:
            resp = SESSION.get(url, params=params, timeout=25)
            if resp.status_code == 200:
                return resp.json()
            if resp.status_code == 429:
                wait = sleeps[min(attempt, len(sleeps) - 1)]
                retry_after = resp.headers.get("Retry-After")
                if retry_after and str(retry_after).isdigit():
                    wait = max(wait, int(retry_after))
                time.sleep(wait + random.uniform(0, 4))
                continue
            return None
        except requests.RequestException:
            pass
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
        result.extend(prods)
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
        discount = round(100 - product_rub * 100 / basic_rub)
        key = (discount, basic_rub - product_rub)
        if best is None or key > best[0]:
            best = (key, product_rub, basic_rub)
    if best is None:
        product = basic = discount = benefit = 0
    else:
        _, product, basic = best
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


def deal(card):
    d = raw_deal(card)
    if (
        not d["id"]
        or d["product"] <= 0
        or d["basic"] <= d["product"]
    ):
        return None
    if _out_of_stock(card):
        return None
    if _blacklisted(d):
        return None
    if d["discount"] < config.MIN_DISCOUNT:
        return None
    if config.MAX_PRICE and d["product"] > config.MAX_PRICE:
        return None
    if config.MIN_RATING and d["rating"] < config.MIN_RATING:
        return None
    return d


def deal_from_search(item):
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
        }
    )


def _http_ok(url):
    try:
        return SESSION.get(url, timeout=8, stream=True).status_code == 200
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
