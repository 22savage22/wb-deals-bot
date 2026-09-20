"""Small independent catalog for outfits, unaffected by channel price/topic caps."""
import os
import time
from collections import Counter

import requests

import wb
from .catalog import normalize
from .sync import upload
from .media import verified_photo

QUERIES = ("платье женское", "футболка женская", "джинсы женские",
           "кроссовки женские", "футболка мужская", "джинсы мужские",
           "кроссовки мужские", "сумка женская", "серьги женские")
EXTRA_QUERIES = ("блузка женская", "лоферы женские", "юбка женская",
                 "ремень женский", "кепка женская", "ваза для дома",
                 "браслет женский", "сумка мужская", "рубашка мужская",
                 "джемпер женский", "плед для дома", "куртка мужская")


def query_plan(products, epoch, now):
    """Keep complete male/female foundations; visit scarce groups first."""
    coverage = Counter((p.get('audience', 'unknown'), p['slot']) for p in products
                       if p.get('image') and p.get('enabled') is not False
                       and 0 <= now - p.get('checked_at', 0) < 86400)
    extras = tuple(EXTRA_QUERIES[(epoch * 2 + i) % len(EXTRA_QUERIES)]
                   for i in range(min(2, len(EXTRA_QUERIES))))
    queries = list(dict.fromkeys(QUERIES + extras))
    if queries:
        shift = epoch % len(queries)
        queries = queries[shift:] + queries[:shift]
    def count(query):
        p = normalize({'id': 1, 'title': query, 'price': 1})
        return coverage[(p['audience'], p['slot'])]
    return sorted(queries, key=count)


def collect(on_batch=None, products=(), epoch=None, seconds=1120):
    result = {}
    now = time.time()
    epoch = int(now // 21600) if epoch is None else epoch
    deadline = time.monotonic() + seconds
    known = {p['id']: p for p in products}
    def ready(pid):
        p = known.get(pid, {})
        return p.get('image') and 0 <= now - p.get('checked_at', 0) < 86400
    for query in query_plan(products, epoch, now):
        if time.monotonic() >= deadline:
            break
        expected = normalize({"id": 1, "title": query, "price": 1})
        added = 0
        found = wb.search(query, 1 + epoch % 3)[:60]
        ids = list(dict.fromkeys(p['id'] for p in found if p.get('id')
                                and p['id'] not in result and not ready(p['id'])
                                and known.get(p['id'], {}).get('enabled') is not False))
        if ids:
            offset = (epoch * 6) % len(ids)
            ids = (ids[offset:] + ids[:offset])[:18]
        # Lazy batches avoid fetching all cards before the first useful upload.
        def cards():
            for start in range(0, len(ids), 6):
                if time.monotonic() >= deadline:
                    return
                yield from wb.cards(ids[start:start + 6])
        for card in cards():
            if time.monotonic() >= deadline:
                break
            deal, _ = wb.evaluate(card, min_discount=0, min_rating=4.5, min_feedbacks=20, max_price=15000)
            if not deal or deal["id"] in result or deal["product"] > 15000:
                continue
            product = normalize(deal)
            if product['slot'] != expected['slot'] or (expected['audience'] != 'unknown'
                    and product['audience'] not in ('unknown', expected['audience'])):
                continue
            # Photos are fetched only for a few approved candidates, not every result.
            photo = verified_photo(deal['id'], known.get(deal['id'], {}).get('image', ''))
            if not photo:
                continue
            product = normalize({**deal, 'checked_at': int(time.time()), 'image': photo})
            if not product['image']:
                continue
            result[deal["id"]] = product
            added += 1
            if on_batch:
                on_batch([product])
            if added >= 4:
                break
        time.sleep(1)
    return list(result.values())


def main():
    if not os.getenv("MINIAPP_API_URL") or not os.getenv("MINIAPP_SYNC_KEY"):
        print("Mini App not configured; catalog scan skipped")
        return
    response = requests.get(os.environ['MINIAPP_API_URL'].rstrip('/') + '/api/catalog', timeout=(5, 30))
    response.raise_for_status()
    products = collect(on_batch=upload, products=response.json()['products'])
    if not products:
        print("No new verified products this run; previous catalog was preserved")
        return
    print(f"Catalog scan complete: {len(products)} products")


if __name__ == "__main__":
    main()
