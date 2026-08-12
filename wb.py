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
CARDS = "https://card.wb.ru/cards/v4/detail"

_HOSTS = {}


def _get(url, params=None, tries=5):
    sleeps = (10, 20, 30, 45, 60)
    for attempt in range(tries):
        try:
            resp = SESSION.get(url, params=params, timeout=25)
            if resp.status_code == 200:
                return resp.json()
            if resp.status_code == 429:
                time.sleep(sleeps[min(attempt, len(sleeps) - 1)] + random.uniform(0, 4))
                continue
            return None
        except requests.RequestException:
            pass
        time.sleep(3 + attempt * 3)
    return None


def search(query, page):
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
    for attempt in range(3):
        data = _get(SEARCH, params)
        if not data:
            return []
        products = (data.get("data") or {}).get("products")
        if products is None:
            products = data.get("products")
        if products is not None:
            return products
        time.sleep(5 + attempt * 10)
    return []


def cards(ids):
    result = []
    for i in range(0, len(ids), 20):
        chunk = ids[i : i + 20]
        data = _get(
            CARDS,
            params={
                "appType": "1",
                "curr": "rub",
                "dest": str(config.DEST),
                "spp": "30",
                "nm": ";".join(str(x) for x in chunk),
            },
        )
        if data:
            result.extend(data.get("products") or [])
        time.sleep(random.uniform(0.3, 0.8))
    return result


def deal(card):
    sizes = card.get("sizes") or []
    price = None
    for size in sizes:
        p = size.get("price") or {}
        if p.get("product") and p.get("basic"):
            price = p
            break
    if not price:
        return None
    product = price["product"] // 100
    basic = price["basic"] // 100
    if product <= 0 or basic <= product:
        return None
    discount = round(100 - product * 100 / basic)
    if discount < config.MIN_DISCOUNT:
        return None
    if config.MAX_PRICE and product > config.MAX_PRICE:
        return None
    rating = card.get("reviewRating") or card.get("rating") or 0
    if config.MIN_RATING and rating < config.MIN_RATING:
        return None
    return {
        "id": card.get("id"),
        "title": card.get("name") or "",
        "brand": card.get("brand") or "",
        "product": product,
        "basic": basic,
        "discount": discount,
        "benefit": basic - product,
        "rating": rating,
        "feedbacks": card.get("feedbacks") or card.get("nmFeedbacks") or 0,
        "category": str(
            card.get("subjectName") or card.get("subject") or "другое"
        ).strip(),
    }


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


def photo(nm):
    host = _basket_host(nm)
    if not host:
        return None
    vol = nm // 100000
    part = nm // 1000
    base = f"https://basket-{host}.wbbasket.ru/vol{vol}/part{part}/{nm}/images"
    for path in ("big/1.webp", "c516x688/1.webp", "c246x328/1.webp"):
        try:
            resp = SESSION.get(f"{base}/{path}", timeout=20)
            if resp.status_code != 200:
                continue
            img = Image.open(BytesIO(resp.content))
            if img.mode != "RGB":
                img = img.convert("RGB")
            img.thumbnail((1280, 1280))
            buf = BytesIO()
            img.save(buf, format="JPEG", quality=88)
            buf.seek(0)
            return buf
        except Exception:
            continue
    return None
