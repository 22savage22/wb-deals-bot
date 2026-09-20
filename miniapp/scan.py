"""Small independent catalog for outfits, unaffected by channel price/topic caps."""
import os
import time

import wb
from .catalog import normalize
from .sync import upload

QUERIES = ("платье женское", "блузка женская", "футболка женская",
           "джинсы женские", "юбка женская", "кроссовки женские",
           "лоферы женские", "сумка женская", "серьги женские")
EXTRA_QUERIES = ("ремень женский", "кепка женская", "футболка мужская",
                 "джинсы мужские", "кроссовки мужские", "ваза для дома",
                 "браслет женский", "сумка мужская")


def collect(on_batch=None):
    result = {}
    # Two rotating discovery categories per run keep all interests represented
    # without multiplying the scheduled job's slow WB requests.
    offset = (int(time.time() // 21600) * 2) % len(EXTRA_QUERIES)
    queries = QUERIES + EXTRA_QUERIES[offset:offset + 2]
    for query in queries:
        expected_slot = normalize({"id": 1, "title": query, "price": 1})["slot"]
        added = 0
        found = wb.search(query, 1)[:30]
        ids = [p["id"] for p in found if p.get("id")]
        for card in (wb.cards(ids) if ids else [])[:12]:
            deal, _ = wb.evaluate(card, min_discount=0, min_rating=4.5, min_feedbacks=20)
            if not deal or deal["id"] in result or deal["product"] > 15000:
                continue
            product = normalize(deal)
            if product["slot"] != expected_slot:
                continue
            # Photos are fetched only for a few approved candidates, not every result.
            if not wb.photos(deal["id"], limit=1):
                continue
            product = normalize({**deal, 'checked_at': int(time.time()), 'image': wb.photo_url(deal['id'])})
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
    products = collect(on_batch=upload)
    if not products:
        raise SystemExit("No verified products from WB; previous catalog was preserved")
    print(f"Catalog scan complete: {len(products)} products")


if __name__ == "__main__":
    main()
