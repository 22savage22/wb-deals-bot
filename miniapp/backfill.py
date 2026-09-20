"""Gradually repair old catalog photos with fresh WB cards, never guessed URLs."""
import os
import time
from collections import defaultdict, deque

import requests
import wb
from .catalog import normalize
from .sync import upload


def candidates(products, epoch, limit=24):
    """Rotate attempts across runs and categories; unavailable IDs cannot block all."""
    groups = defaultdict(deque)
    missing = sorted((p for p in products if not p.get('image')), key=lambda p: p['id'])
    if missing:
        offset = (epoch * limit) % len(missing)
        missing = missing[offset:] + missing[:offset]
    for p in missing:
        groups[p.get('slot', 'other')].append(p['id'])
    result = []
    while groups and len(result) < limit:
        for slot in list(groups):
            result.append(groups[slot].popleft())
            if not groups[slot]:
                del groups[slot]
            if len(result) == limit:
                break
    return result


def repair(products, on_batch=None, limit=24, seconds=480):
    deadline = time.monotonic() + seconds
    ids = candidates(products, int(time.time() // 21600), limit)
    result = []
    for start in range(0, len(ids), 6):
        if time.monotonic() >= deadline:
            break
        for card in wb.cards(ids[start:start + 6]):
            if time.monotonic() >= deadline:
                break
            deal, _ = wb.evaluate(card, min_discount=0, min_rating=4.5, min_feedbacks=20)
            if not deal or deal['product'] > 15000:
                continue
            if not wb.photos(deal['id'], limit=1):
                continue
            product = normalize({**deal, 'image': wb.photo_url(deal['id']), 'checked_at': int(time.time())})
            if not product['image']:
                continue
            result.append(product)
            # Persist each verified item so a late WB timeout loses no earlier work.
            if on_batch:
                on_batch([product])
    return result


def main():
    url = os.environ.get('MINIAPP_API_URL', '').rstrip('/')
    if not url or not os.environ.get('MINIAPP_SYNC_KEY'):
        print('Mini App not configured; photo repair skipped')
        return
    response = requests.get(url + '/api/catalog', timeout=(5, 30))
    response.raise_for_status()
    products = response.json()['products']
    result = repair(products, on_batch=upload)
    print(f'Photo repair: {len(result)} verified products; existing saved items preserved')


if __name__ == '__main__':
    main()
